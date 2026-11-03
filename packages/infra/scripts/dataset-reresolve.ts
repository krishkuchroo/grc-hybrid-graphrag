// `pnpm dataset:reresolve --org <slug> --as <email> [--dry-run]` (FX-002; D24, D38, D39, D45.5,
// D45.7, D50, D51, D56, D69, D163, D164, D230, D263 item 2): repairs an org loaded before FX-001.
//
// Why (D263): those orgs' documents were uploaded with a 1-hour API key, revoked when the upload
// ended. Extraction resolved the chunks hours later in the uploader's view, and a revoked key sees
// nothing (D230's fail-safe rule, unchanged), so no name was matched: hundreds of links wait as
// pending with unmatched ends, and names of records the org has became proposed new records. This
// command re-runs only the matching and decision step on the extraction answers already stored on
// the chunks (packages/api/src/processing/decide/reresolve.ts): no text-model call and no
// re-extraction; bge-m3 is still called for close-meaning matching.
//
// Whose view: the `--as` member's own, read as the processing reads a person (their member row's
// role and clearance, with their user ID). It is never wider than that person's: records they can't
// see are never matched, linked or named. The org's Admin at Restricted (`admin@<slug>.example` when
// `pnpm dataset:load` made the org) is the view the old key had. The role and clearance used are
// printed, never the email.
//
// Which chunks: in the org, stage `resolved` with a stored answer (full mode), the document not
// removed and not the system's own fast load, and the document's uploader seeing nothing now. A
// document whose uploader still sees is left alone and counted. Documents in upload order, each
// document's chunks in position order.
//
// What it writes, per chunk: the confident links live through `writeLiveLinks`, each with its
// `link.created` entry (D56); the chunk's stale pending link findings UPDATED IN PLACE (same IDs, so
// `/review/<id>` links and saved chat lists still work; one whose new key another row holds becomes
// `superseded`); new findings as the job adds them; the chunk-to-record rows. Per document, after
// all its chunks: its pending record findings no chunk proposes now become `superseded` (kept,
// hidden from the review queue, never an Analyst decision), and one `processing.reresolved` audit
// entry in that last transaction. Findings the Analyst decided are never touched.
//
// Re-runs change nothing more and print 0 changes. A chunk whose records changed meanwhile, or
// while Ollama can't embed, is skipped and counted; the document's last step then waits too, the
// command exits 1 at the end, and a later run picks them up. `--dry-run` reads and matches (bge-m3
// is called) and writes nothing to Neo4j or Postgres; it prints what it would do.
//
// Refused with exit 2, nothing changed: unknown or repeated arguments; no such org; an email that
// isn't a member of the org with a known role and clearance; bge-m3 not answering on Ollama
// (dataset-common.ts's check, the embedder only: the text model isn't needed); missing settings.
//
// Output (D164): per document its ID and counts, the totals, and the skips by code. Never a name, a
// sentence or an email. An error prints its type and code only. Settings: see org-script-env.ts.
import type { ScriptDb } from './org-script-env.js';
// Loaded by URL: plain `node` needs the `.ts` file name, which tsc refuses in an import path. The
// env module goes first: it lets the api's `./x.js` imports load their `.ts`.
type Env = typeof import('./org-script-env.js');
const { connect, describeError, load, missingSettings, provisioning, setting, sqlTag } = (await import(
  new URL('./org-script-env.ts', import.meta.url).href
)) as Env;
type Common = typeof import('./dataset-common.js');
const common = (await import(new URL('./dataset-common.ts', import.meta.url).href)) as Common;

const NAME = 'dataset:reresolve';
const USAGE = `usage: pnpm ${NAME} --org <org slug> --as <member email> [--dry-run]`;
const VALUE_FLAGS = ['--org', '--as'] as const;
type ValueFlag = (typeof VALUE_FLAGS)[number];
const DRY_RUN = '--dry-run';

interface Args {
  slug: string;
  email: string;
  dryRun: boolean;
}

function refuse(problems: readonly string[], usage = true): never {
  for (const p of problems) console.error(`${NAME}: ${p}`);
  if (usage) console.error(USAGE);
  console.error(`${NAME}: nothing was changed.`);
  process.exit(2);
}

function parse(argv: readonly string[]): Args {
  const values: Partial<Record<ValueFlag, string>> = {};
  let dryRun = false;
  const problems: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--') continue;
    if (arg === DRY_RUN) {
      if (dryRun) problems.push(`${DRY_RUN} is given twice`);
      dryRun = true;
      continue;
    }
    const eq = arg.indexOf('=');
    const flag = (eq > 0 ? arg.slice(0, eq) : arg) as ValueFlag;
    if (!VALUE_FLAGS.includes(flag)) {
      // Never echo the argument: it may be an email.
      problems.push(`argument ${i + 1} is unknown: only --org, --as and ${DRY_RUN} are accepted`);
      continue;
    }
    if (values[flag] !== undefined) problems.push(`${flag} is given twice`);
    if (eq > 0) values[flag] = arg.slice(eq + 1);
    else if (i + 1 < argv.length) values[flag] = argv[++i]!;
    else values[flag] = '';
  }

  const slug = (values['--org'] ?? '').trim();
  if (values['--org'] === undefined) problems.push('--org is missing (the org slug)');
  else if (!provisioning.SLUG.test(slug) || slug.length > 100) {
    problems.push('--org must be an org slug: lowercase letters and digits, joined by single hyphens');
  }
  const email = (values['--as'] ?? '').trim().toLowerCase();
  if (values['--as'] === undefined) problems.push('--as is missing (the email of the org member whose view is used)');
  else if (!provisioning.EMAIL.test(email)) problems.push('--as must look like name@example.com');

  if (problems.length > 0) refuse(problems);
  return { slug, email, dryRun };
}

// ---- The api modules, as far as this command uses them -----------------------------------------

interface View {
  role: string;
  clearance: string;
  userId?: string;
}
interface Counts {
  linksLive: number;
  linksUpdated: number;
  linksAdded: number;
  linksSuperseded: number;
  linksUnpaired: number;
  recordsAdded: number;
  chunkRecords: number;
}
type ChunkOutcome =
  | {
      status: 'reresolved';
      chunkId: string;
      documentId: string;
      proposedKeys: string[];
      refused: number;
      counts: Counts;
    }
  | { status: 'skipped'; chunkId: string; documentId?: string; reason: string };
type DocumentOutcome =
  | { status: 'finished'; documentId: string; recordsSuperseded: number; audited: boolean }
  | { status: 'skipped'; documentId: string; reason: string };
interface Options {
  dryRun: boolean;
}
interface ReresolveModule {
  NO_CHANGES: Readonly<Counts>;
  addCounts(a: Counts, b: Counts): Counts;
  personView(db: unknown, orgId: string, userId: string): Promise<View | null>;
  reresolveSelection(
    db: unknown,
    orgId: string,
  ): Promise<{ documents: { documentId: string; chunkIds: string[] }[]; uploaderSees: number }>;
  reresolveChunk(
    deps: object,
    input: { orgId: string; chunkId: string },
    view: View,
    opts: Options,
  ): Promise<ChunkOutcome>;
  finishReresolvedDocument(
    deps: object,
    input: { orgId: string; documentId: string; proposedKeys: ReadonlySet<string>; chunks: number; counts: Counts },
    view: View,
    opts: Options,
  ): Promise<DocumentOutcome>;
}

function countsLine(c: Counts, dryRun: boolean): string {
  const w = dryRun ? 'would be ' : '';
  return (
    `links ${w}made live ${c.linksLive}, ${w}updated in place ${c.linksUpdated}, ${w}added ${c.linksAdded}, ` +
    `${w}superseded ${c.linksSuperseded}, left as they were ${c.linksUnpaired}; record findings ${w}added ` +
    `${c.recordsAdded}; chunk-to-record rows ${w}added ${c.chunkRecords}`
  );
}

function bump(map: Map<string, number>, code: string): void {
  map.set(code, (map.get(code) ?? 0) + 1);
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;

// ---- The run ---------------------------------------------------------------------------------

const args = parse(process.argv.slice(2));
const started = performance.now();

// The matcher reads as the member's role x clearance account, so the query secret is needed too.
const missing = [...missingSettings(), ...(setting('NEO4J_QUERY_SECRET') ? [] : ['NEO4J_QUERY_SECRET'])];
if (missing.length > 0) refuse([`missing settings (environment or .env): ${missing.join(', ')}`], false);

let aiSettings: ReturnType<Common['datasetAiSettings']>;
try {
  aiSettings = common.datasetAiSettings(setting);
} catch (err) {
  refuse([`the AI settings are not usable: ${err instanceof Error ? err.message : 'unknown setting'}`], false);
}

const sql = await sqlTag();
const { orgIdForSlug } = await load<{ orgIdForSlug(slug: string): string }>('identity/provision-org.ts');
const reresolve = await load<ReresolveModule>('processing/decide/reresolve.ts');
const conn = await connect();
const db: ScriptDb = conn.deps.db;

async function main(): Promise<void> {
  const orgId = orgIdForSlug(args.slug);

  // The org and the member, then their view.
  const member = await common.findOrgMember(db, sql, orgId, args.slug, args.email);
  if (!member.found) {
    refused(
      member.missing === 'org'
        ? [`there is no org ${args.slug}.`]
        : [`the --as email is not a member of ${args.slug}.`],
    );
    return;
  }
  const view = await reresolve.personView(db, orgId, member.userId);
  if (view === null) {
    refused([`the --as member of ${args.slug} has no known role and clearance.`]);
    return;
  }

  // bge-m3 on Ollama answers (the embedder only: no text model is called).
  const problems = await common.checkDatasetModels(aiSettings, 'fast');
  if (problems.length > 0) {
    refused([...problems.map((p) => `${p}.`), 'the repair needs bge-m3 answering for close-meaning matching.']);
    return;
  }

  const { AuditOutbox } = await load<{ AuditOutbox: new (graph: unknown) => object }>('audit/outbox.ts');
  const { AuditService } = await load<{ AuditService: new (db: unknown) => object }>('audit/audit.service.ts');
  const { NameMatcher } = await load<{ NameMatcher: new (d: { graph: unknown; embedder: unknown }) => object }>(
    'processing/match/name-matcher.ts',
  );
  const { OllamaEmbedder } = await load<{ OllamaEmbedder: new (o: { settings: unknown; log?: unknown }) => object }>(
    'ai/ollama-embedder.ts',
  );
  const { createLogger } = await load<{ createLogger(stream?: { write(line: string): void }): unknown }>(
    'common/logger.ts',
  );
  // The api's own log lines stay out of the output (D164: this command prints its own counts).
  const quiet = createLogger({ write: () => undefined });
  const graph = conn.deps.graph;
  const deps = {
    db,
    graph,
    outbox: new AuditOutbox(graph),
    matcher: new NameMatcher({ graph, embedder: new OllamaEmbedder({ settings: aiSettings, log: quiet }) }),
    audit: new AuditService(db),
    log: quiet,
  };

  const selection = await reresolve.reresolveSelection(db, orgId);
  const chunkCount = selection.documents.reduce((n, d) => n + d.chunkIds.length, 0);
  console.log(
    `${NAME}: ${args.slug} (${orgId})${args.dryRun ? ', dry run (nothing is written)' : ''}: as role ${view.role} ` +
      `at clearance ${view.clearance}; ${selection.documents.length} document(s) with ${chunkCount} chunk(s) ` +
      `whose uploader sees nothing now; ${selection.uploaderSees} document(s) whose uploader still sees left alone`,
  );

  let totals: Counts = { ...reresolve.NO_CHANGES };
  let recordsSuperseded = 0;
  let documentsFinished = 0;
  let audited = 0;
  const chunkSkips = new Map<string, number>();
  const documentSkips = new Map<string, number>();
  for (const doc of selection.documents) {
    let counts: Counts = { ...reresolve.NO_CHANGES };
    const proposedKeys = new Set<string>();
    let done = 0;
    let waiting = false;
    let removed = false;
    for (const chunkId of doc.chunkIds) {
      let outcome: ChunkOutcome;
      try {
        outcome = await reresolve.reresolveChunk(deps, { orgId, chunkId }, view, { dryRun: args.dryRun });
      } catch (err) {
        console.error(`${NAME}: document ${doc.documentId} chunk ${chunkId}: failed: ${describeError(err)}`);
        bump(chunkSkips, 'failed');
        waiting = true;
        continue;
      }
      if (outcome.status === 'skipped') {
        bump(chunkSkips, outcome.reason);
        if (outcome.reason === 'document_removed') removed = true;
        else waiting = true;
        continue;
      }
      done += 1;
      counts = reresolve.addCounts(counts, outcome.counts);
      for (const key of outcome.proposedKeys) proposedKeys.add(key);
    }
    totals = reresolve.addCounts(totals, counts);

    // The document's last step only once every chunk of it was re-resolved in this run.
    let finish: string;
    if (removed) {
      bump(documentSkips, 'document_removed');
      finish = '; skipped: document_removed';
    } else if (waiting) {
      bump(documentSkips, 'chunks_waiting');
      finish = '; last step waits: chunks_waiting';
    } else {
      let outcome: DocumentOutcome;
      try {
        outcome = await reresolve.finishReresolvedDocument(
          deps,
          { orgId, documentId: doc.documentId, proposedKeys, chunks: done, counts },
          view,
          { dryRun: args.dryRun },
        );
      } catch (err) {
        console.error(`${NAME}: document ${doc.documentId}: its last step failed: ${describeError(err)}`);
        outcome = { status: 'skipped', documentId: doc.documentId, reason: 'failed' };
      }
      if (outcome.status === 'skipped') {
        bump(documentSkips, outcome.reason);
        finish = `; last step skipped: ${outcome.reason}`;
      } else {
        documentsFinished += 1;
        recordsSuperseded += outcome.recordsSuperseded;
        if (outcome.audited) audited += 1;
        finish =
          `; record findings ${args.dryRun ? 'would be ' : ''}superseded ${outcome.recordsSuperseded}` +
          (outcome.audited ? '; audit entry written' : '');
      }
    }
    console.log(
      `  document ${doc.documentId}: chunks re-resolved ${done} of ${doc.chunkIds.length}; ` +
        `${countsLine(counts, args.dryRun)}${finish}`,
    );
  }

  console.log(
    `Totals: documents finished ${documentsFinished} of ${selection.documents.length}; ` +
      `${countsLine(totals, args.dryRun)}; record findings ${args.dryRun ? 'would be ' : ''}superseded ` +
      `${recordsSuperseded}; audit entries ${audited}.`,
  );
  const skipLine = (m: Map<string, number>): string => [...m].map(([code, n]) => `${code} ${n}`).join(', ') || 'none';
  console.log(`Skipped chunks: ${skipLine(chunkSkips)}. Documents not finished: ${skipLine(documentSkips)}.`);
  // Anything but a removed document waits for a later run.
  const later = [...chunkSkips.keys(), ...documentSkips.keys()].some((code) => code !== 'document_removed');
  if (later) {
    console.error(`${NAME}: some chunks or documents wait; run the same command again later to finish them.`);
    process.exitCode = 1;
  }
  if (args.dryRun) console.log('Dry run: nothing was written. Run without --dry-run to repair.');
  console.log(`Time: ${seconds(performance.now() - started)}.`);
}

/** Refuses with exit 2: the problem is printed, nothing was changed. */
function refused(lines: readonly string[]): void {
  for (const line of lines) console.error(`${NAME}: ${line}`);
  console.error(`${NAME}: nothing was changed.`);
  process.exitCode = 2;
}

try {
  await main();
} catch (err) {
  console.error(`${NAME}: failed: ${describeError(err)}`);
  console.error(`${NAME}: fix the cause and run the same command again; it finishes what is left.`);
  process.exitCode = 1;
} finally {
  await conn.close();
}
