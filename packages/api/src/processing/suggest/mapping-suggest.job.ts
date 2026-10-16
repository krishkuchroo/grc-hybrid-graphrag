// The mapping-suggestion run (S4-009; D15, D16 (b), D20, D24, D38, D45.5–D45.8, D51, D52.1, D52.3,
// D69, D72, D163, D212 (4)): the `processing.mapping-suggest` handler. It runs in the worker program
// only, one run at a time (Gemma x1), under the intake system context in Postgres, and reads the
// graph as the read-only account of the person who started it.
//
// For one run it:
//   1. looks up whose view it works in: the starter's current role and clearance in the org (an API
//      key's own, while it is neither revoked nor expired), never above the clearance they started
//      with; a starter who is gone or may no longer suggest mappings ends the run with nothing done;
//   2. lists the items: each active control the starter can see and map (`controls`), or each
//      active SOC 2 criterion (`soc2_to_nist`);
//   3. for each item with a name embedding, takes the 5 closest active items of the target
//      framework by name embedding (the starter's framework, or NIST 800-53), leaves out the pairs
//      already linked or already suggested (any status, so a rejected one is never raised again),
//      and asks Gemma which of the rest truly fit, each with a short reason (prompt
//      `suggest-mappings-v1`); items with no embedding yet are skipped and counted;
//   4. stores one `pending` `mapping` finding per pick (SATISFIES from the control, or MAPS_TO from
//      the criterion to the NIST control), labelled the higher of the two ends' labels, with the
//      model and prompt version. A repeat adds nothing (the finding key). Nothing goes to Neo4j:
//      the Analyst decides (S5).
// Ollama down: the run stops and runs again a minute later without using up a try (D45.7). A long
// run works in slices of a few minutes, each ending by running again a second later, so no try
// outlives pg-boss's time limit; the items a slice finished are remembered in the worker, so the
// next slice carries on after them (forgotten when the run ends, or after a few hours; a worker
// that restarts starts the run again from the top, which adds nothing twice). Any other error
// fails the try (D72). Log lines hold only IDs, counts, timings and codes, never a name, a
// prompt or an answer (D163).
import type { OnApplicationBootstrap } from '@nestjs/common';
import {
  FRAMEWORK_KEYS,
  LABELS,
  ROLES,
  canMapControl,
  canSuggestMappings,
  isLabel,
  isRole,
  mappingProposalSchema,
  type FrameworkKey,
  type Label,
  type MappingLinkType,
  type MappingProposal,
} from '@grc/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { z } from 'zod';
import { AiCallError, AiInputError, isAiFailure } from '../../ai/ai-failure.js';
import type { TextAnswer, TextModel } from '../../ai/text-model.js';
import { errorKind } from '../../common/errors.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext } from '../../db/org-context.js';
import { apiKeys } from '../../identity/api-keys.schema.js';
import { member } from '../../identity/schema.js';
import { RunLater, type JobHandlerInput, type JobsService } from '../../jobs/jobs.module.js';
import { INTAKE_SYSTEM_CONTEXT } from '../../intake/queues.js';
import { reviewFindings, type NewReviewFindingRow } from '../processing.schema.js';
import {
  MAPPING_SUGGEST_KINDS,
  PROCESSING_CONCURRENCY,
  PROCESSING_JOB_KEYS,
  PROCESSING_QUEUES,
  type MappingSuggestKind,
} from '../queues.js';
import {
  NIST_800_53_FRAMEWORK,
  readCandidates,
  readCatalogEmbeddingCounts,
  readItems,
  readLinked,
  type SuggestCandidate,
  type SuggestGraph,
  type SuggestItem,
  type SuggestViewer,
} from './suggest-graph.js';
import {
  SUGGEST_CANDIDATES,
  SUGGEST_MAX_OUTPUT_TOKENS,
  SUGGEST_PROMPT_VERSION,
  checkPicks,
  suggestAnswerSchema,
  suggestAnswerShape,
  suggestData,
  suggestInstructions,
  type PromptItem,
  type SuggestAnswer,
} from './suggest-prompt.js';

/** How long the run waits while Ollama is down before it tries again (D45.7). */
export const OLLAMA_WAIT_SECONDS = 60;

/** A slice of a run starts no new item after this long, then the run carries on a second later.
 * With one Gemma call's limit and one wait for the program's Gemma slot on top, a try stays well
 * inside pg-boss's 15-minute limit on an active job. */
export const SLICE_BUDGET_MS = 5 * 60_000;
const NEXT_SLICE_SECONDS = 1;

/** The time limit of one suggestion call. */
export const SUGGEST_CALL_TIMEOUT_MS = 180_000;

/** How long the worker remembers the items a run finished. */
export const PROGRESS_TTL_MS = 6 * 60 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY_STARTER_PREFIX = 'api_key:';

/** The run job's data (queues.ts `MappingSuggestJob`), checked. */
export const mappingSuggestJobSchema = z
  .object({
    orgId: z.string().regex(UUID),
    kind: z.enum(MAPPING_SUGGEST_KINDS),
    framework: z.enum(FRAMEWORK_KEYS).optional(),
    startedBy: z.string().min(1).max(200),
    role: z.enum(ROLES),
    clearance: z.enum(LABELS),
  })
  .superRefine((job, ctx) => {
    if (job.kind === 'controls' && job.framework === undefined) {
      ctx.addIssue({ code: 'custom', path: ['framework'], message: 'a controls run names its framework' });
    }
  });
export type MappingSuggestJobData = z.infer<typeof mappingSuggestJobSchema>;

/** What a run counted. */
export interface SuggestCounts {
  /** Items looked at. */
  items: number;
  /** Items skipped because they have no name embedding yet. */
  withoutEmbedding: number;
  /** Active items of the target framework the starter can see that have no name embedding yet. */
  targetWithoutEmbedding: number;
  /** Items with no candidate of the target framework at all. */
  noCandidates: number;
  /** Items whose candidates were all linked or suggested already. */
  alreadyHandled: number;
  /** Items Gemma was asked about. */
  asked: number;
  /** Items whose call timed out, gave no usable answer or failed. */
  failed: number;
  /** Picks kept, and picks dropped (outside the candidates, repeated, with no reason, or refused by the schema). */
  picks: number;
  dropped: number;
  /** Findings stored, and picks a finding already held. */
  added: number;
  repeats: number;
}

function emptyCounts(): SuggestCounts {
  return {
    items: 0,
    withoutEmbedding: 0,
    targetWithoutEmbedding: 0,
    noCandidates: 0,
    alreadyHandled: 0,
    asked: 0,
    failed: 0,
    picks: 0,
    dropped: 0,
    added: 0,
    repeats: 0,
  };
}

export type MappingSuggestOutcome =
  { status: 'done'; counts: SuggestCounts } | { status: 'skipped'; reason: 'bad_job_data' | 'starter_not_allowed' };

/** The items a run finished, kept between its slices (see the top of the file). */
export class SuggestProgress {
  private readonly runs = new Map<string, { done: Set<string>; counts: SuggestCounts; touchedAt: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  /** The run's progress, made empty when there is none; runs untouched for `PROGRESS_TTL_MS` are forgotten. */
  take(key: string): { done: Set<string>; counts: SuggestCounts } {
    const now = this.now();
    for (const [k, run] of this.runs) {
      if (now - run.touchedAt > PROGRESS_TTL_MS) this.runs.delete(k);
    }
    let run = this.runs.get(key);
    if (!run) {
      run = { done: new Set(), counts: emptyCounts(), touchedAt: now };
      this.runs.set(key, run);
    }
    run.touchedAt = now;
    return run;
  }

  forget(key: string): void {
    this.runs.delete(key);
  }
}

export interface MappingSuggestDeps {
  db: Db;
  graph: SuggestGraph;
  model: TextModel;
  progress: SuggestProgress;
  log?: Logger;
  /** How long a slice starts new items; `SLICE_BUDGET_MS` by default. */
  sliceBudgetMs?: number;
  now?: () => number;
}

function lowerLabel(a: Label, b: Label): Label {
  return LABELS.indexOf(a) <= LABELS.indexOf(b) ? a : b;
}

function higherLabel(a: Label, b: Label): Label {
  return LABELS.indexOf(a) >= LABELS.indexOf(b) ? a : b;
}

/** The finding key of a suggested pair: a repeat proposal finds the first and adds nothing. */
export function mappingFindingKey(type: MappingLinkType, fromId: string, toId: string): string {
  return `mapping:${type}:${fromId}:${toId}`;
}

/**
 * Whose view the run works in: the starter's current role and clearance in the org (an API key's
 * own, while it works), never above the clearance the run was started with. Null when the starter
 * is gone or may no longer suggest mappings (fail safe).
 */
export async function starterView(
  db: Db,
  job: MappingSuggestJobData,
  now: Date = new Date(),
): Promise<SuggestViewer | null> {
  const current = await withOrgContext(db, INTAKE_SYSTEM_CONTEXT(job.orgId), async (tx) => {
    if (job.startedBy.startsWith(KEY_STARTER_PREFIX)) {
      const keyId = job.startedBy.slice(KEY_STARTER_PREFIX.length);
      if (!UUID.test(keyId)) return null;
      const [row] = await tx
        .select({
          role: apiKeys.role,
          clearance: apiKeys.clearance,
          expiresAt: apiKeys.expiresAt,
          revokedAt: apiKeys.revokedAt,
        })
        .from(apiKeys)
        .where(and(eq(apiKeys.orgId, job.orgId), eq(apiKeys.id, keyId)))
        .limit(1);
      if (!row || row.revokedAt !== null || row.expiresAt <= now) return null;
      return { role: row.role, clearance: row.clearance as string };
    }
    const [row] = await tx
      .select({ role: member.role, clearance: member.clearance })
      .from(member)
      .where(and(eq(member.organizationId, job.orgId), eq(member.userId, job.startedBy)))
      .limit(1);
    return row ? { role: row.role, clearance: row.clearance } : null;
  });
  if (!current || !isRole(current.role) || !isLabel(current.clearance)) return null;
  if (!canSuggestMappings(current.role) || !canSuggestMappings(job.role)) return null;
  return {
    userId: job.startedBy,
    role: current.role,
    clearance: lowerLabel(current.clearance, job.clearance),
  };
}

/** The keys of `keys` that are findings already, whatever their status. */
async function suggestedKeys(db: Db, orgId: string, keys: string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await withOrgContext(db, INTAKE_SYSTEM_CONTEXT(orgId), (tx) =>
    tx
      .select({ key: reviewFindings.findingKey })
      .from(reviewFindings)
      .where(and(eq(reviewFindings.orgId, orgId), inArray(reviewFindings.findingKey, keys))),
  );
  return new Set(rows.map((r) => r.key));
}

/** Stores the findings; a key already there adds nothing. Answers how many were stored. */
async function storeFindings(db: Db, orgId: string, rows: NewReviewFindingRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  const stored = await withOrgContext(db, INTAKE_SYSTEM_CONTEXT(orgId), (tx) =>
    tx
      .insert(reviewFindings)
      .values(rows)
      .onConflictDoNothing({ target: [reviewFindings.orgId, reviewFindings.findingKey] })
      .returning({ id: reviewFindings.id }),
  );
  return stored.length;
}

/** The item as the prompt shows it. */
function promptItem(kind: MappingSuggestKind, item: SuggestItem): PromptItem {
  if (kind === 'controls') {
    return {
      fields: [
        { label: 'Control', value: item.name },
        { label: 'Code', value: item.code },
        { label: 'Source note', value: item.detail },
      ],
    };
  }
  return {
    fields: [
      { label: 'Criterion', value: item.code },
      { label: 'Title', value: item.name },
      { label: 'Description', value: item.detail },
    ],
  };
}

interface RunContext {
  deps: MappingSuggestDeps;
  job: MappingSuggestJobData;
  viewer: SuggestViewer;
  target: FrameworkKey;
  type: MappingLinkType;
  indexSize: number;
  counts: SuggestCounts;
  log: Logger;
}

/** One item: candidates, the open pairs, Gemma's picks and the findings. Throws `RunLater` while
 * Ollama is down; the item then counts as not done. */
async function suggestFor(run: RunContext, item: SuggestItem): Promise<void> {
  const { deps, job, viewer, target, type, counts } = run;
  if (!item.embedded) {
    counts.withoutEmbedding += 1;
    return;
  }
  const candidates = await readCandidates(deps.graph, job.orgId, viewer, {
    kind: job.kind,
    itemId: item.id,
    target,
    limit: SUGGEST_CANDIDATES,
    indexSize: run.indexSize,
  });
  if (candidates.length === 0) {
    counts.noCandidates += 1;
    return;
  }
  const linked = await readLinked(deps.graph, job.orgId, viewer, {
    kind: job.kind,
    itemId: item.id,
    candidateIds: candidates.map((c) => c.id),
  });
  const seen = await suggestedKeys(
    deps.db,
    job.orgId,
    candidates.map((c) => mappingFindingKey(type, item.id, c.id)),
  );
  const open: SuggestCandidate[] = candidates.filter(
    (c) => !linked.has(c.id) && !seen.has(mappingFindingKey(type, item.id, c.id)),
  );
  if (open.length === 0) {
    counts.alreadyHandled += 1;
    return;
  }

  let answer: TextAnswer<SuggestAnswer>;
  try {
    answer = await deps.model.generate({
      instructions: suggestInstructions(job.kind, target),
      data: suggestData(promptItem(job.kind, item), open),
      schema: suggestAnswerSchema,
      answerShape: suggestAnswerShape(open.length),
      timeoutMs: SUGGEST_CALL_TIMEOUT_MS,
      maxOutputTokens: SUGGEST_MAX_OUTPUT_TOKENS,
    });
  } catch (err) {
    if (isAiFailure(err, 'unavailable')) {
      throw new RunLater(OLLAMA_WAIT_SECONDS, 'the model service is unavailable');
    }
    if (isAiFailure(err) || err instanceof AiCallError || err instanceof AiInputError) {
      counts.asked += 1;
      counts.failed += 1;
      run.log.warn(
        { orgId: job.orgId, itemId: item.id, code: isAiFailure(err) ? err.code : err.name },
        'mapping suggestion call failed',
      );
      return;
    }
    throw err;
  }
  counts.asked += 1;

  const { picks, dropped } = checkPicks(answer.value, open.length);
  counts.dropped += dropped;
  const rows: NewReviewFindingRow[] = [];
  for (const pick of picks) {
    const candidate = open[pick.index];
    if (!candidate) {
      counts.dropped += 1;
      continue;
    }
    const proposal: MappingProposal = {
      type,
      from: { recordId: item.id, number: item.number },
      to: { recordId: candidate.id, number: candidate.number },
      reason: pick.reason,
    };
    const checked = mappingProposalSchema.safeParse(proposal);
    if (!checked.success) {
      counts.dropped += 1;
      continue;
    }
    rows.push({
      orgId: job.orgId,
      kind: 'mapping',
      status: 'pending',
      findingKey: mappingFindingKey(type, item.id, candidate.id),
      proposal: checked.data as unknown as Record<string, unknown>,
      label: higherLabel(item.label, candidate.label),
      model: answer.model,
      promptVersion: SUGGEST_PROMPT_VERSION,
    });
  }
  counts.picks += rows.length;
  const added = await storeFindings(deps.db, job.orgId, rows);
  counts.added += added;
  counts.repeats += rows.length - added;
}

/** The progress key of a run: its job key and whose view it works in. */
function progressKey(job: MappingSuggestJobData): string {
  return [
    PROCESSING_JOB_KEYS.mappingSuggest(job.orgId, job.kind, job.framework),
    job.startedBy,
    job.role,
    job.clearance,
  ].join('|');
}

/** One try of a run (see the top of the file). */
export async function runMappingSuggest(
  deps: MappingSuggestDeps,
  job: JobHandlerInput,
): Promise<MappingSuggestOutcome> {
  const log = deps.log ?? createLogger().child({ context: 'MappingSuggest' });
  const now = deps.now ?? Date.now;
  const parsed = mappingSuggestJobSchema.safeParse(job.data);
  if (!parsed.success) {
    log.warn({ jobId: job.id }, 'mapping suggestions skipped: bad job data');
    return { status: 'skipped', reason: 'bad_job_data' };
  }
  const data = parsed.data;
  const key = progressKey(data);
  const startedAt = now();

  try {
    const viewer = await starterView(deps.db, data);
    if (!viewer) {
      deps.progress.forget(key);
      log.warn(
        { jobId: job.id, orgId: data.orgId, kind: data.kind },
        'mapping suggestions skipped: starter not allowed',
      );
      return { status: 'skipped', reason: 'starter_not_allowed' };
    }
    const target: FrameworkKey = data.kind === 'controls' ? data.framework! : NIST_800_53_FRAMEWORK;
    const type: MappingLinkType = data.kind === 'controls' ? 'SATISFIES' : 'MAPS_TO';
    const progress = deps.progress.take(key);

    const allItems = await readItems(deps.graph, data.orgId, viewer, data.kind);
    // A control the starter can't map is never sent to Gemma (D212 (3), D51).
    const items =
      data.kind === 'controls'
        ? allItems.filter((item) => canMapControl(viewer, { label: item.label, owner: item.owner ?? '' }))
        : allItems;
    const catalog = await readCatalogEmbeddingCounts(deps.graph, data.orgId, viewer, target);
    progress.counts.targetWithoutEmbedding = catalog.targetMissing;

    const run: RunContext = {
      deps,
      job: data,
      viewer,
      target,
      type,
      indexSize: catalog.embedded,
      counts: progress.counts,
      log,
    };
    const budget = deps.sliceBudgetMs ?? SLICE_BUDGET_MS;
    for (const item of items) {
      if (progress.done.has(item.id)) continue;
      if (now() - startedAt >= budget) {
        log.info(
          { jobId: job.id, orgId: data.orgId, kind: data.kind, done: progress.done.size, items: items.length },
          'mapping suggestions carry on in the next slice',
        );
        throw new RunLater(NEXT_SLICE_SECONDS, 'next slice');
      }
      await suggestFor(run, item);
      progress.done.add(item.id);
      progress.counts.items += 1;
    }

    deps.progress.forget(key);
    log.info(
      {
        jobId: job.id,
        orgId: data.orgId,
        kind: data.kind,
        framework: target,
        model: deps.model.modelName,
        promptVersion: SUGGEST_PROMPT_VERSION,
        ...progress.counts,
        elapsedMs: Math.round(now() - startedAt),
      },
      'mapping suggestions finished',
    );
    return { status: 'done', counts: { ...progress.counts } };
  } catch (err) {
    if (err instanceof RunLater) throw err;
    if (job.isLastAttempt) deps.progress.forget(key);
    log.error(
      { jobId: job.id, orgId: data.orgId, kind: data.kind, attempt: job.attempt, ...errorKind(err) },
      'mapping suggestions failed',
    );
    throw err;
  }
}

/** Registers the handler in the worker program only. */
export class MappingSuggestWorker implements OnApplicationBootstrap {
  private readonly log = createLogger().child({ context: 'MappingSuggest' });
  private readonly progress = new SuggestProgress();

  constructor(
    private readonly jobs: JobsService,
    private readonly deps: Omit<MappingSuggestDeps, 'log' | 'progress'>,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.jobs.processesJobs) return;
    const deps: MappingSuggestDeps = { ...this.deps, progress: this.progress, log: this.log };
    await this.jobs.work(
      PROCESSING_QUEUES.mappingSuggest,
      async (job) => {
        await runMappingSuggest(deps, job);
      },
      { concurrency: PROCESSING_CONCURRENCY.mappingSuggest },
    );
  }
}
