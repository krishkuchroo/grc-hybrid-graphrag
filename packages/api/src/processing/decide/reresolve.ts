// The repair of chunks resolved in a view that saw nothing (FX-002; D24, D38, D39, D40, D41, D45.5,
// D45.6, D45.7, D50, D51, D52.5, D56, D69, D73, D163, D164, D230, D263 item 2). Run only by the
// operator's command `pnpm dataset:reresolve` (packages/infra/scripts/dataset-reresolve.ts); never by
// the API or the worker.
//
// Why (D263): orgs loaded before FX-001 uploaded their documents with a 1-hour API key that was
// revoked when the upload ended. `processing.chunk-resolve` ran hours later in the uploader's view,
// and a revoked key sees nothing (D230's fail-safe rule, ./uploader-view.ts, unchanged), so no name
// was matched: every link waited as `pending` with unmatched ends and every name became a proposed
// new record. This re-runs only the matching and decision step on the answers the text model already
// gave (stored on the chunk): no text-model call and no re-extraction. bge-m3 is still called for
// the close-meaning step of matching.
//
// Whose view: the one the caller passes, which the command reads for the org member it is told to
// act as, the way ./uploader-view.ts reads a person (their member row's role and clearance, with
// their user ID; `personView`). Records that member can't see are never matched, linked or named,
// so the repair never sees beyond that person's own view.
//
// Per chunk (`reresolveChunk`), the same parts as the job (./chunk-resolve.job.ts, ./decide-rules.ts):
//   1. the stored answer read leniently, every record matched in the view, the rule checks, the
//      links the Analyst refused dropped;
//   2. the confident links written live by `writeLiveLinks` (./live-links.ts), each with its
//      `link.created` entry in the same Neo4j transaction (D56), inside the document's removal check
//      (`unlessRemoved`);
//   3. one Postgres transaction under the intake system context, the document row locked FOR UPDATE
//      and nothing written once it is removed:
//      - the chunk's old pending `link` findings are paired with the new links by type and by each
//        end's kind and normalised name (the names `identityOfLink` compares, not the record IDs,
//        which the old run never had). A paired old row is UPDATED IN PLACE (key, proposal, failed
//        checks, label, status, updated_at), so its ID, `/review/<id>` links and saved chat lists
//        still work. When its new key already belongs to another row, the old row becomes
//        `superseded` and the other row is left as it is;
//      - a new link with no old row is inserted as the job inserts it; an old pending row with no
//        new link is left as it is and counted;
//      - new `record` findings are inserted as the job inserts them (the same key adds nothing), and
//        the chunk-to-record rows for every clear match (the same row adds nothing);
//      - the chunk stays `resolved` (only `updated_at` moves, when something changed) and the
//        document's status doesn't change.
// Per document, after all its chunks (`finishReresolvedDocument`), one Postgres transaction with the
// document locked: every pending `record` finding of the document that none of its re-resolved
// chunks proposes now becomes `superseded`, and one `processing.reresolved` audit entry (actor
// `system:processing`, target the document, IDs and counts only) is appended in the same
// transaction (D45.4, D69).
//
// `superseded` (Q-FX-1 (a)): set only here, only from `pending`; `decided_by` and `decided_at` stay
// null (it isn't a decision); the review queue, its counts and the chat's "Not reviewed yet" list
// treat it as not there (`findingVisibility`). Findings the Analyst decided (`approved`, `rejected`,
// `removed`) and `live` ones are never touched, and other chunks' findings only by the record rule.
// Nothing is deleted (D24: grc_app has no DELETE on review_findings).
//
// Re-runs (D45.5): a second run finds the rows already updated (the same keys), `writeLiveLinks`
// finds its own links (`ours`), superseded findings stay so, and nothing changes; the audit entry is
// appended again only when something changed, or when the document has none yet (a run stopped
// between its chunks and the document's step). Records that changed since they were matched, and
// Ollama being down, skip the chunk (`changed_meanwhile`, `embedder_unavailable`) and leave the
// document unfinished for a later run. `dryRun` reads and matches (bge-m3 is called) and reads the
// graph for the links that already exist, but writes nothing to Neo4j or Postgres.
//
// Logs (D163): none here. The command prints IDs, counts and codes only, never a name or a sentence.
import {
  NODE_LABELS,
  linkProposalSchema,
  normaliseName,
  readExtractionAnswer,
  type Label,
  type LinkProposal,
  type RuleCheck,
} from '@grc/shared';
import { and, eq, inArray, isNotNull, ne, notInArray } from 'drizzle-orm';
import type { Db } from '../../db/client.js';
import { withOrgContext, type Tx } from '../../db/org-context.js';
import { auditEvents } from '../../audit/audit.schema.js';
import type { AuditService } from '../../audit/audit.service.js';
import { documents } from '../../intake/intake.schema.js';
import { INTAKE_SYSTEM_CONTEXT } from '../../intake/queues.js';
import type { MatchView } from '../match/name-matcher.js';
import { PROCESSING_ACTOR } from '../match/record-merge.js';
import {
  chunkRecords,
  chunks,
  reviewFindings,
  type ChunkRecordKind,
  type NewChunkRecordRow,
  type NewReviewFindingRow,
} from '../processing.schema.js';
import {
  addRecordFindings,
  load,
  refusedLinks,
  toWrite,
  unavailable,
  unlessRemoved,
  type ChunkResolveDeps,
  type Ids,
  type Loaded,
} from './chunk-resolve.job.js';
import {
  evaluateLinks,
  identityOfLink,
  isRefused,
  linkProposal,
  matchedEnds,
  proposedRecords,
  type EvaluatedLink,
  type LinkSourceDocument,
  type ProposedRecord,
} from './decide-rules.js';
import { LinkEndsChanged, writeLiveLinks, type LiveLinkOutcome, type LiveLinkWrite } from './live-links.js';
import { uploaderView } from './uploader-view.js';

/** The audit action of a repaired document. */
export const RERESOLVED_ACTION = 'processing.reresolved';

/** What a chunk's (or a document's) repair changed, or in a dry run would change. */
export interface ReresolveCounts {
  /** Links made live in the graph now (`writeLiveLinks` answered `created`). */
  linksLive: number;
  /** Old pending link findings updated in place. */
  linksUpdated: number;
  /** Link findings added. */
  linksAdded: number;
  /** Old pending link findings made `superseded` (their new key already belonged to another row). */
  linksSuperseded: number;
  /** Old pending link findings with no new link, left as they are. */
  linksUnpaired: number;
  /** Record findings added. */
  recordsAdded: number;
  /** Chunk-to-record rows added. */
  chunkRecords: number;
}

export const NO_CHANGES: Readonly<ReresolveCounts> = Object.freeze({
  linksLive: 0,
  linksUpdated: 0,
  linksAdded: 0,
  linksSuperseded: 0,
  linksUnpaired: 0,
  recordsAdded: 0,
  chunkRecords: 0,
});

/** The counts of two runs added up. */
export function addCounts(a: ReresolveCounts, b: ReresolveCounts): ReresolveCounts {
  return {
    linksLive: a.linksLive + b.linksLive,
    linksUpdated: a.linksUpdated + b.linksUpdated,
    linksAdded: a.linksAdded + b.linksAdded,
    linksSuperseded: a.linksSuperseded + b.linksSuperseded,
    linksUnpaired: a.linksUnpaired + b.linksUnpaired,
    recordsAdded: a.recordsAdded + b.recordsAdded,
    chunkRecords: a.chunkRecords + b.chunkRecords,
  };
}

/** Whether the counts say something was written (an unpaired row is left as it is: no change). */
export function changedAnything(c: ReresolveCounts): boolean {
  return c.linksLive + c.linksUpdated + c.linksAdded + c.linksSuperseded + c.recordsAdded + c.chunkRecords > 0;
}

/** Why a chunk was not re-resolved. `changed_meanwhile` and `embedder_unavailable` are the job's
 * `RunLater` cases: a later run picks the chunk up. */
export type ReresolveChunkSkip =
  | 'chunk_not_found'
  | 'not_resolved'
  | 'not_full_mode'
  | 'document_removed'
  | 'changed_meanwhile'
  | 'embedder_unavailable';

export type ReresolveChunkOutcome =
  | {
      status: 'reresolved';
      chunkId: string;
      documentId: string;
      /** The keys of the record findings this chunk proposes now (for the document's record rule). */
      proposedKeys: string[];
      /** Links dropped because the Analyst refused them before. */
      refused: number;
      counts: ReresolveCounts;
    }
  | { status: 'skipped'; chunkId: string; documentId?: string; reason: ReresolveChunkSkip };

/** Why a document's last step didn't run: removed meanwhile, or chunks of it still in processing
 * (the record rule needs every chunk's proposals). */
export type ReresolveDocumentSkip = 'document_removed' | 'document_in_progress';

export type ReresolveDocumentOutcome =
  | { status: 'finished'; documentId: string; recordsSuperseded: number; audited: boolean }
  | { status: 'skipped'; documentId: string; reason: ReresolveDocumentSkip };

export interface ReresolveOptions {
  dryRun: boolean;
}

// ---- The pure parts ---------------------------------------------------------------------------

/** One link end by kind and name. */
export interface NamedEnd {
  kind: string;
  name: string;
}

/**
 * The key two link findings of one chunk are paired by: the type, and each end's kind and
 * normalised name (`identityOfLink`'s name keys), never the matched record, which the stale run
 * didn't have. A name with nothing left after normalising is compared as written (trimmed), as the
 * finding key does, so two such names never pair by accident.
 */
export function linkPairKey(type: string, from: NamedEnd, to: NamedEnd): string {
  return `${type}|${endPairKey(from)}|${endPairKey(to)}`;
}

function endPairKey(end: NamedEnd): string {
  const key = normaliseName(end.name);
  return key !== '' ? `${end.kind}:${key}` : `${end.kind}=${end.name.trim()}`;
}

/** The pair key of an evaluated link: its type and its ends' kinds and names as Gemma wrote them. */
export function pairKeyOfLink(link: EvaluatedLink): string {
  return linkPairKey(link.type, link.from, link.to);
}

/** The pair key of a stored link finding's proposal, or null when it isn't one. */
export function pairKeyOfProposal(raw: unknown): string | null {
  const parsed = linkProposalSchema.safeParse(raw);
  if (!parsed.success) return null;
  const p = parsed.data;
  return linkPairKey(p.type, p.from, p.to);
}

/** A stored pending link finding of the chunk. */
export interface OldLinkFinding {
  id: string;
  findingKey: string;
  proposal: unknown;
  failedChecks: readonly string[];
  label: string;
  status: string;
}

/** A link finding as this run would write it. */
export interface NewLinkFinding {
  key: string;
  pairKey: string;
  proposal: LinkProposal;
  failedChecks: RuleCheck[];
  label: Label;
  status: 'live' | 'pending';
}

/** The columns an in-place update sets. */
export interface LinkFindingUpdate {
  id: string;
  findingKey: string;
  proposal: LinkProposal;
  failedChecks: RuleCheck[];
  label: Label;
  status: 'live' | 'pending';
}

/** What the Postgres step does with the chunk's link findings, in this order. */
export interface LinkFindingPlan {
  /** Old rows updated in place, in order (each new key is free when its turn comes). */
  updates: LinkFindingUpdate[];
  /** Old rows made `superseded`: their new key already belongs to another row. */
  superseded: string[];
  /** New links with no old row and no row of their key yet, inserted. */
  inserts: NewLinkFinding[];
  /** Old rows with no new link (or an unreadable proposal), left as they are. */
  unpaired: string[];
  /** Old rows paired with a new link that are already as it would write them. */
  unchanged: string[];
}

/** JSON with every object's keys sorted, so a jsonb value read back compares with a fresh one. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        )
      : v,
  );
}

function sameRow(old: OldLinkFinding, fresh: NewLinkFinding): boolean {
  return (
    old.findingKey === fresh.key &&
    old.status === fresh.status &&
    old.label === fresh.label &&
    old.failedChecks.length === fresh.failedChecks.length &&
    old.failedChecks.every((c, i) => c === fresh.failedChecks[i]) &&
    canonical(old.proposal) === canonical(fresh.proposal)
  );
}

/**
 * How the chunk's old pending link findings meet the new links (see the top of the file). `taken`
 * holds the rows of the org that already have one of the new keys (key to row ID), in any status.
 * Each new link is paired with the first unpaired old row of its pair key (old rows in the order
 * given). Pairs go first, so an old row moving to its new key frees its old one; inserts come after.
 */
export function planLinkFindings(
  old: readonly OldLinkFinding[],
  fresh: readonly NewLinkFinding[],
  taken: ReadonlyMap<string, string>,
): LinkFindingPlan {
  const plan: LinkFindingPlan = { updates: [], superseded: [], inserts: [], unpaired: [], unchanged: [] };
  const owner = new Map<string, string>(taken);
  for (const row of old) owner.set(row.findingKey, row.id);

  const byPair = new Map<string, OldLinkFinding[]>();
  for (const row of old) {
    const pair = pairKeyOfProposal(row.proposal);
    if (pair === null) {
      plan.unpaired.push(row.id);
      continue;
    }
    const list = byPair.get(pair) ?? [];
    list.push(row);
    byPair.set(pair, list);
  }

  const unpairedFresh: NewLinkFinding[] = [];
  for (const link of fresh) {
    const row = byPair.get(link.pairKey)?.shift();
    if (!row) {
      unpairedFresh.push(link);
      continue;
    }
    const holder = owner.get(link.key);
    if (holder !== undefined && holder !== row.id) {
      plan.superseded.push(row.id);
      continue;
    }
    if (sameRow(row, link)) {
      plan.unchanged.push(row.id);
      continue;
    }
    plan.updates.push({
      id: row.id,
      findingKey: link.key,
      proposal: link.proposal,
      failedChecks: link.failedChecks,
      label: link.label,
      status: link.status,
    });
    if (owner.get(row.findingKey) === row.id) owner.delete(row.findingKey);
    owner.set(link.key, row.id);
  }
  for (const rows of byPair.values()) for (const row of rows) plan.unpaired.push(row.id);

  for (const link of unpairedFresh) {
    // The same key adds nothing: its row is already there (or this chunk's own, updated above).
    if (owner.has(link.key)) continue;
    plan.inserts.push(link);
    owner.set(link.key, `new:${link.key}`);
  }
  return plan;
}

// ---- The view --------------------------------------------------------------------------------

/**
 * The view of the org member `userId`, read the way the uploader's view reads a person
 * (./uploader-view.ts): their member row's role and clearance, with their user ID; null when they
 * aren't a member or a value isn't known (they see nothing).
 */
export async function personView(db: Db, orgId: string, userId: string): Promise<MatchView | null> {
  return withOrgContext(db, INTAKE_SYSTEM_CONTEXT(orgId), (tx) =>
    uploaderView(tx, { orgId, uploaderType: 'user', uploaderId: userId }),
  );
}

// ---- Which chunks ----------------------------------------------------------------------------

/** A document to repair, with its chunks in position order. */
export interface ReresolveDocument {
  documentId: string;
  chunkIds: string[];
}

export interface ReresolveSelection {
  documents: ReresolveDocument[];
  /** Documents with resolved full-mode chunks whose uploader still sees: left alone. */
  uploaderSees: number;
}

/**
 * The documents to repair (see the command): in the org, chunks at stage `resolved` with a stored
 * answer (full mode), their document not removed and not the system's own fast load, and the
 * document's uploader seeing nothing now (`uploaderView` is null, read as the job reads it).
 * Documents in upload order, chunks in position order.
 */
export async function reresolveSelection(db: Db, orgId: string, now: Date = new Date()): Promise<ReresolveSelection> {
  return withOrgContext(db, INTAKE_SYSTEM_CONTEXT(orgId), async (tx) => {
    const rows = await tx
      .select({
        chunkId: chunks.id,
        documentId: chunks.documentId,
        position: chunks.position,
        uploaderType: documents.uploaderType,
        uploaderId: documents.uploaderId,
        createdAt: documents.createdAt,
      })
      .from(chunks)
      .innerJoin(documents, and(eq(documents.orgId, chunks.orgId), eq(documents.id, chunks.documentId)))
      .where(
        and(
          eq(chunks.orgId, orgId),
          eq(chunks.stage, 'resolved'),
          isNotNull(chunks.extraction),
          ne(documents.status, 'removed'),
          ne(documents.uploaderType, 'system'),
        ),
      )
      .orderBy(documents.createdAt, documents.id, chunks.position);
    const byDocument = new Map<
      string,
      { uploaderType: (typeof rows)[number]['uploaderType']; uploaderId: string; chunkIds: string[] }
    >();
    for (const row of rows) {
      const doc = byDocument.get(row.documentId) ?? {
        uploaderType: row.uploaderType,
        uploaderId: row.uploaderId,
        chunkIds: [],
      };
      doc.chunkIds.push(row.chunkId);
      byDocument.set(row.documentId, doc);
    }
    const out: ReresolveSelection = { documents: [], uploaderSees: 0 };
    for (const [documentId, doc] of byDocument) {
      const view = await uploaderView(tx, { orgId, uploaderType: doc.uploaderType, uploaderId: doc.uploaderId }, now);
      if (view !== null) out.uploaderSees += 1;
      else out.documents.push({ documentId, chunkIds: doc.chunkIds });
    }
    return out;
  });
}

// ---- One chunk -------------------------------------------------------------------------------

/**
 * Re-runs the matching and decision step on one resolved full-mode chunk's stored answer, in
 * `view` (see the top of the file). Throws only for errors other than the job's `RunLater` cases.
 */
export async function reresolveChunk(
  deps: ChunkResolveDeps,
  input: { orgId: string; chunkId: string },
  view: MatchView,
  opts: ReresolveOptions,
): Promise<ReresolveChunkOutcome> {
  const orgId = input.orgId.toLowerCase();
  const chunkId = input.chunkId.toLowerCase();
  const loaded = await load(deps, orgId, chunkId);
  if (!loaded) return { status: 'skipped', chunkId, reason: 'chunk_not_found' };
  const { ids } = loaded;
  const skip = (reason: ReresolveChunkSkip): ReresolveChunkOutcome => ({
    status: 'skipped',
    chunkId,
    documentId: ids.documentId,
    reason,
  });
  if (loaded.documentStatus === 'removed') return skip('document_removed');
  if (loaded.stage !== 'resolved') return skip('not_resolved');
  if (loaded.embedOnly || loaded.extraction === null || !loaded.model || !loaded.promptVersion) {
    return skip('not_full_mode');
  }
  const model = loaded.model;
  const promptVersion = loaded.promptVersion;
  const { answer } = readExtractionAnswer(loaded.extraction);

  // 1. What each name means in the given view.
  let matches: Awaited<ReturnType<ChunkResolveDeps['matcher']['matchAll']>>;
  try {
    matches = await deps.matcher.matchAll(
      orgId,
      view,
      answer.records.map((r) => ({ kind: r.kind, name: r.name })),
    );
  } catch (err) {
    if (unavailable(err)) return skip('embedder_unavailable');
    throw err;
  }
  const ends = matchedEnds(ids.documentId, answer.records, matches);
  const proposed = proposedRecords(answer.records, ends);

  // 2. The rule checks, without the links the Analyst refused before.
  const evaluated = evaluateLinks({
    chunkId: ids.chunkId,
    chunkText: loaded.text,
    documentLabel: loaded.label,
    links: answer.links,
    ends,
  });
  const refused = await refusedLinks(deps.db, orgId, evaluated);
  const kept = evaluated.filter((link) => !isRefused(identityOfLink(link), refused));

  // 3. The confident ones live, through `writeLiveLinks` only, inside the removal check. A dry run
  //    only reads which of them the graph already has.
  const source: LinkSourceDocument = { recordType: loaded.recordType, label: loaded.label };
  const confident = kept.flatMap((link) => toWrite(link, source));
  let outcomes: Map<string, LiveLinkOutcome> | null;
  try {
    outcomes =
      confident.length === 0
        ? new Map()
        : opts.dryRun
          ? await previewLiveLinks(deps, orgId, ids.chunkId, confident)
          : await unlessRemoved(deps.db, ids, () =>
              writeLiveLinks(
                { outbox: deps.outbox },
                orgId,
                view,
                {
                  documentId: ids.documentId,
                  chunkId: ids.chunkId,
                  model,
                  promptVersion,
                  sourceLabel: loaded.label,
                  sourceRecordType: loaded.recordType,
                },
                confident,
              ),
            );
  } catch (err) {
    if (err instanceof LinkEndsChanged) return skip('changed_meanwhile');
    throw err;
  }
  if (outcomes === null) return skip('document_removed');
  const linksLive = [...outcomes.values()].filter((o) => o === 'created').length;

  // 4. The findings and the chunk-to-record rows, in one Postgres transaction.
  const matched = new Map<string, ChunkRecordKind>();
  for (const end of ends.values()) if (end.match) matched.set(end.match.recordId, end.kind);
  const saved = await saveChunk(deps, loaded, { model, promptVersion }, proposed, kept, outcomes, matched, opts);
  if (saved === 'removed') return skip('document_removed');
  return {
    status: 'reresolved',
    chunkId,
    documentId: ids.documentId,
    proposedKeys: proposed.map((p) => p.key),
    refused: evaluated.length - kept.length,
    counts: { ...saved, linksLive },
  };
}

/**
 * What `writeLiveLinks` would answer for each link, read only: `ours` when this chunk's AI link is
 * there, `exists` for one from elsewhere, else `created`. In the org's own database, read-only.
 */
async function previewLiveLinks(
  deps: ChunkResolveDeps,
  orgId: string,
  chunkId: string,
  links: readonly LiveLinkWrite[],
): Promise<Map<string, LiveLinkOutcome>> {
  return deps.graph.read(orgId, async (tx) => {
    const out = new Map<string, LiveLinkOutcome>();
    for (const link of links) {
      const res = await tx.run(
        `MATCH (a:${NODE_LABELS[link.from.kind]} {id: $fromId})-[r:${link.type}]->(b:${NODE_LABELS[link.to.kind]} {id: $toId})
         RETURN r.origin AS origin, r.chunkId AS chunkId
         LIMIT 1`,
        { fromId: link.from.id, toId: link.to.id },
      );
      const row = res.records[0];
      if (!row) out.set(link.key, 'created');
      else if (row.get('origin') === 'ai' && row.get('chunkId') === chunkId) out.set(link.key, 'ours');
      else out.set(link.key, 'exists');
    }
    return out;
  });
}

/** The document's status (undefined when it is gone), its row locked FOR UPDATE for the rest of the
 * transaction as the job's Postgres step locks it; a dry run only reads it. */
async function documentStatus(
  tx: Tx,
  ids: Pick<Ids, 'orgId' | 'documentId'>,
  dryRun: boolean,
): Promise<string | undefined> {
  const query = tx
    .select({ status: documents.status })
    .from(documents)
    .where(and(eq(documents.orgId, ids.orgId), eq(documents.id, ids.documentId)));
  const [row] = dryRun ? await query : await query.for('update');
  return row?.status;
}

// The chunk's Postgres step (see the top of the file). Answers the counts, or `removed` with
// nothing written.
async function saveChunk(
  deps: ChunkResolveDeps,
  loaded: Loaded,
  source: { model: string; promptVersion: string },
  proposed: readonly ProposedRecord[],
  kept: readonly EvaluatedLink[],
  outcomes: ReadonlyMap<string, LiveLinkOutcome>,
  matched: ReadonlyMap<string, ChunkRecordKind>,
  opts: ReresolveOptions,
): Promise<Omit<ReresolveCounts, 'linksLive'> | 'removed'> {
  const { ids } = loaded;
  return withOrgContext(deps.db, INTAKE_SYSTEM_CONTEXT(ids.orgId), async (tx) => {
    const now = deps.now?.() ?? new Date();
    const status = await documentStatus(tx, ids, opts.dryRun);
    if (status === undefined || status === 'removed') return 'removed' as const;

    // Record findings first: the link proposals point to them (as the job does).
    const records = opts.dryRun
      ? await existingRecordFindings(tx, ids.orgId, proposed)
      : await addRecordFindings(tx, loaded, proposed, source.model, source.promptVersion);

    // The links as this run would write them.
    const fresh: NewLinkFinding[] = [];
    const sentences = new Map<string, string>();
    for (const link of kept) {
      const proposal = linkProposal(link, records.ids);
      if (!proposal) continue;
      const outcome = outcomes.get(link.key);
      fresh.push({
        key: link.key,
        pairKey: pairKeyOfLink(link),
        proposal,
        failedChecks: link.failed,
        label: link.label,
        status: outcome === 'created' || outcome === 'ours' ? 'live' : 'pending',
      });
      sentences.set(link.key, link.sentence);
    }

    // The chunk's old pending link findings, and the rows that already hold one of the new keys.
    const oldQuery = tx
      .select({
        id: reviewFindings.id,
        findingKey: reviewFindings.findingKey,
        proposal: reviewFindings.proposal,
        failedChecks: reviewFindings.failedChecks,
        label: reviewFindings.label,
        status: reviewFindings.status,
      })
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.orgId, ids.orgId),
          eq(reviewFindings.kind, 'link'),
          eq(reviewFindings.status, 'pending'),
          eq(reviewFindings.chunkId, ids.chunkId),
        ),
      )
      .orderBy(reviewFindings.createdAt, reviewFindings.id);
    const old: OldLinkFinding[] = opts.dryRun ? await oldQuery : await oldQuery.for('update');
    const freshKeys = fresh.map((f) => f.key);
    const taken = new Map<string, string>();
    if (freshKeys.length > 0) {
      const holders = await tx
        .select({ id: reviewFindings.id, findingKey: reviewFindings.findingKey })
        .from(reviewFindings)
        .where(and(eq(reviewFindings.orgId, ids.orgId), inArray(reviewFindings.findingKey, freshKeys)));
      for (const h of holders) taken.set(h.findingKey, h.id);
    }
    const plan = planLinkFindings(old, fresh, taken);

    // Chunk-to-record rows for every clear match.
    const chunkRecordRows: NewChunkRecordRow[] = [...matched].map(([recordId, recordKind]) => ({
      orgId: ids.orgId,
      chunkId: ids.chunkId,
      recordId,
      recordKind,
      chunkRecordType: loaded.recordType,
      label: loaded.chunkLabel,
    }));

    if (opts.dryRun) {
      return {
        linksUpdated: plan.updates.length,
        linksAdded: plan.inserts.length,
        linksSuperseded: plan.superseded.length,
        linksUnpaired: plan.unpaired.length,
        recordsAdded: records.added,
        chunkRecords: chunkRecordRows.length - (await existingChunkRecords(tx, ids, [...matched.keys()])),
      };
    }

    let linksUpdated = 0;
    for (const u of plan.updates) {
      const done = await tx
        .update(reviewFindings)
        .set({
          findingKey: u.findingKey,
          proposal: u.proposal,
          failedChecks: u.failedChecks,
          label: u.label,
          status: u.status,
          updatedAt: now,
        })
        .where(
          and(eq(reviewFindings.orgId, ids.orgId), eq(reviewFindings.id, u.id), eq(reviewFindings.status, 'pending')),
        )
        .returning({ id: reviewFindings.id });
      linksUpdated += done.length;
    }
    let linksSuperseded = 0;
    if (plan.superseded.length > 0) {
      const done = await tx
        .update(reviewFindings)
        .set({ status: 'superseded', updatedAt: now })
        .where(
          and(
            eq(reviewFindings.orgId, ids.orgId),
            inArray(reviewFindings.id, plan.superseded),
            eq(reviewFindings.status, 'pending'),
          ),
        )
        .returning({ id: reviewFindings.id });
      linksSuperseded = done.length;
    }
    const insertRows: NewReviewFindingRow[] = plan.inserts.map((link) => ({
      orgId: ids.orgId,
      kind: 'link',
      status: link.status,
      findingKey: link.key,
      proposal: link.proposal,
      documentId: ids.documentId,
      chunkId: ids.chunkId,
      sentence: sentences.get(link.key) ?? null,
      failedChecks: link.failedChecks,
      label: link.label,
      model: source.model,
      promptVersion: source.promptVersion,
    }));
    const added =
      insertRows.length === 0
        ? []
        : await tx
            .insert(reviewFindings)
            .values(insertRows)
            .onConflictDoNothing({ target: [reviewFindings.orgId, reviewFindings.findingKey] })
            .returning({ id: reviewFindings.id });
    const linked =
      chunkRecordRows.length === 0
        ? []
        : await tx
            .insert(chunkRecords)
            .values(chunkRecordRows)
            .onConflictDoNothing({ target: [chunkRecords.orgId, chunkRecords.chunkId, chunkRecords.recordId] })
            .returning({ recordId: chunkRecords.recordId });

    const counts = {
      linksUpdated,
      linksAdded: added.length,
      linksSuperseded,
      linksUnpaired: plan.unpaired.length,
      recordsAdded: records.added,
      chunkRecords: linked.length,
    };
    // The chunk stays resolved; only its `updated_at` moves, and only when something changed.
    if (changedAnything({ ...counts, linksLive: 0 })) {
      await tx
        .update(chunks)
        .set({ updatedAt: now })
        .where(and(eq(chunks.orgId, ids.orgId), eq(chunks.id, ids.chunkId), eq(chunks.stage, 'resolved')));
    }
    return counts;
  });
}

// A dry run's record findings: the IDs of those already there by key, and how many would be added.
async function existingRecordFindings(
  tx: Tx,
  orgId: string,
  proposed: readonly ProposedRecord[],
): Promise<{ ids: Map<string, string>; added: number }> {
  const ids = new Map<string, string>();
  if (proposed.length === 0) return { ids, added: 0 };
  const rows = await tx
    .select({ id: reviewFindings.id, key: reviewFindings.findingKey })
    .from(reviewFindings)
    .where(
      and(
        eq(reviewFindings.orgId, orgId),
        inArray(
          reviewFindings.findingKey,
          proposed.map((p) => p.key),
        ),
      ),
    );
  for (const row of rows) ids.set(row.key, row.id);
  return { ids, added: proposed.filter((p) => !ids.has(p.key)).length };
}

// A dry run's chunk-to-record rows already there.
async function existingChunkRecords(tx: Tx, ids: Ids, recordIds: readonly string[]): Promise<number> {
  if (recordIds.length === 0) return 0;
  const rows = await tx
    .select({ recordId: chunkRecords.recordId })
    .from(chunkRecords)
    .where(
      and(
        eq(chunkRecords.orgId, ids.orgId),
        eq(chunkRecords.chunkId, ids.chunkId),
        inArray(chunkRecords.recordId, [...recordIds]),
      ),
    );
  return rows.length;
}

// ---- One document ----------------------------------------------------------------------------

export interface ReresolveDocumentDeps {
  db: Db;
  audit: Pick<AuditService, 'appendInTx'>;
  now?: () => Date;
}

/**
 * A document's last step, after every one of its chunks was re-resolved in this run (see the top
 * of the file): its stale pending record findings become `superseded`, and one `processing.reresolved`
 * entry goes in the same transaction. `chunks` and `counts` are what its chunks' repair did.
 */
export async function finishReresolvedDocument(
  deps: ReresolveDocumentDeps,
  input: {
    orgId: string;
    documentId: string;
    proposedKeys: ReadonlySet<string>;
    chunks: number;
    counts: ReresolveCounts;
  },
  view: MatchView,
  opts: ReresolveOptions,
): Promise<ReresolveDocumentOutcome> {
  const orgId = input.orgId.toLowerCase();
  const documentId = input.documentId.toLowerCase();
  return withOrgContext(deps.db, INTAKE_SYSTEM_CONTEXT(orgId), async (tx) => {
    const now = deps.now?.() ?? new Date();
    const status = await documentStatus(tx, { orgId, documentId }, opts.dryRun);
    if (status === undefined || status === 'removed') {
      return { status: 'skipped', documentId, reason: 'document_removed' } as const;
    }
    // The record rule needs every chunk's proposals: none may still be on its way.
    const [unfinished] = await tx
      .select({ id: chunks.id })
      .from(chunks)
      .where(
        and(
          eq(chunks.orgId, orgId),
          eq(chunks.documentId, documentId),
          notInArray(chunks.stage, ['resolved', 'failed']),
        ),
      )
      .limit(1);
    if (unfinished) return { status: 'skipped', documentId, reason: 'document_in_progress' } as const;

    const keys = [...input.proposedKeys];
    const stale = and(
      eq(reviewFindings.orgId, orgId),
      eq(reviewFindings.documentId, documentId),
      eq(reviewFindings.kind, 'record'),
      eq(reviewFindings.status, 'pending'),
      keys.length > 0 ? notInArray(reviewFindings.findingKey, keys) : undefined,
    );
    let recordsSuperseded: number;
    if (opts.dryRun) {
      recordsSuperseded = (await tx.select({ id: reviewFindings.id }).from(reviewFindings).where(stale)).length;
      return { status: 'finished', documentId, recordsSuperseded, audited: false } as const;
    }
    const done = await tx
      .update(reviewFindings)
      .set({ status: 'superseded', updatedAt: now })
      .where(stale)
      .returning({ id: reviewFindings.id });
    recordsSuperseded = done.length;

    // One entry per repaired document; a re-run that changes nothing adds none.
    const changed = changedAnything(input.counts) || recordsSuperseded > 0;
    const [entry] = changed
      ? []
      : await tx
          .select({ seq: auditEvents.seq })
          .from(auditEvents)
          .where(
            and(
              eq(auditEvents.orgId, orgId),
              eq(auditEvents.action, RERESOLVED_ACTION),
              eq(auditEvents.targetType, 'document'),
              eq(auditEvents.targetId, documentId),
            ),
          )
          .limit(1);
    if (!changed && entry) return { status: 'finished', documentId, recordsSuperseded, audited: false } as const;
    await deps.audit.appendInTx(tx, {
      orgId,
      ...PROCESSING_ACTOR,
      action: RERESOLVED_ACTION,
      targetType: 'document',
      targetId: documentId,
      meta: {
        chunks: input.chunks,
        linksLive: input.counts.linksLive,
        linksUpdated: input.counts.linksUpdated,
        linksAdded: input.counts.linksAdded,
        linksSuperseded: input.counts.linksSuperseded,
        recordsSuperseded,
        chunkRecords: input.counts.chunkRecords,
        asUserId: view.userId ?? null,
        role: view.role,
        clearance: view.clearance,
      },
    });
    return { status: 'finished', documentId, recordsSuperseded, audited: true } as const;
  });
}
