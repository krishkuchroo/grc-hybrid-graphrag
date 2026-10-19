// The graph-query try command (S6-004, behaviour 9; D82 real-Gemma step):
// `pnpm --filter api exec tsx src/search/graph/try.ts [--org <orgId>]`.
// Sends the 10 built-in questions (./try-questions.ts) through the graph-query prompt, as Path B
// does, for an Auditor, and prints for each: the query Gemma wrote, whether it passed our checks
// (or the fallback reason, with the check that refused it), and the seconds taken.
// With `--org <orgId>`, each query that passed is also run read-only in that org's database as the
// Auditor at Internal account (`grc_ro_auditor_internal`), stopped after 5 s, and the rows read
// and the records and links they gave are counted.
// It writes nothing anywhere: no database, no file, no audit entry. It reads the AI settings and,
// with --org, NEO4J_URI and NEO4J_QUERY_SECRET: from the environment, then .env, then the defaults.
// A harmful question's query that names a database or writes is refused by our checks and never
// sent; the summary counts them. Exits 1 when fewer than 8 of the 10 queries pass our checks, or
// when a setting or argument is wrong.
import { pathToFileURL } from 'node:url';
import type { Label, Role } from '@grc/shared';
import { pino } from 'pino';
import { aiSettingsFromEnv, macSideAddress } from '../../ai/ai-settings.js';
import { createTextModel } from '../../ai/text-model-factory.js';
import { readDotEnv } from '../../config/app-settings.js';
import { GraphService } from '../../graph/graph.service.js';
import { readGraphRows } from './graph-results.js';
import { runGraphQuery, writeGraphQuery } from './graph-search.service.js';
import { GRAPH_QUERY_PROMPT_VERSION } from './prompt.js';
import { checkGraphQuery } from './query-check.js';
import { TRY_QUESTIONS } from './try-questions.js';

/** At least 8 of the 10 queries pass our checks (pass criterion 1). */
export const MIN_PASSING = 8;

const ROLE: Role = 'auditor';
const CLEARANCE: Label = 'internal';
const DEFAULT_NEO4J_URI = 'bolt://127.0.0.1:7687';
const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SETTING_NAMES = [
  'OLLAMA_BASE_URL',
  'AI_TEXT_MODEL',
  'AI_EMBEDDING_MODEL',
  'AI_TEXT_PROVIDER',
  'AI_TEXT_BASE_URL',
  'AI_TEXT_API_KEY',
  'NEO4J_URI',
  'NEO4J_QUERY_SECRET',
] as const;

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}

/**
 * The settings this command reads: environment first, then .env files. Never printed.
 * AI_TEXT_BASE_URL is written as the containers see it; this command runs on the Mac, so its host
 * is swapped.
 */
function settingsEnv(): NodeJS.ProcessEnv {
  const dotEnv = readDotEnv(process.cwd());
  const env: NodeJS.ProcessEnv = {};
  for (const name of SETTING_NAMES) {
    const value = [process.env[name], dotEnv[name]].find((v) => typeof v === 'string' && v !== '');
    if (value !== undefined) env[name] = value;
  }
  if (env.AI_TEXT_BASE_URL !== undefined) env.AI_TEXT_BASE_URL = macSideAddress(env.AI_TEXT_BASE_URL);
  return env;
}

/** The org ID after `--org`, null when there is none; throws for anything else. */
export function orgArgument(args: readonly string[]): string | null {
  const at = args.indexOf('--org');
  if (at === -1) return null;
  const orgId = args[at + 1];
  if (orgId === undefined || !LOWERCASE_UUID.test(orgId)) throw new Error('--org needs an org ID (a lowercase UUID).');
  return orgId;
}

export async function runTry(
  args: readonly string[] = process.argv.slice(2),
  write: (line: string) => void = (line) => console.log(line),
): Promise<boolean> {
  const orgId = orgArgument(args);
  const env = settingsEnv();
  const model = createTextModel(aiSettingsFromEnv(env), { log: pino({ level: 'silent' }) });
  let graph: GraphService | null = null;
  if (orgId !== null) {
    const querySecret = env.NEO4J_QUERY_SECRET;
    if (!querySecret) throw new Error('NEO4J_QUERY_SECRET is not set; --org needs it.');
    // Only the read-only query account is ever used: no admin or writer password is read.
    graph = new GraphService({
      uri: env.NEO4J_URI || DEFAULT_NEO4J_URI,
      adminPassword: '',
      writerPassword: '',
      querySecret,
    });
  }

  let passing = 0;
  let harmfulRefused = 0;
  write(`text model: ${model.modelName}, prompt: ${GRAPH_QUERY_PROMPT_VERSION}, described for: ${ROLE}`);
  if (orgId !== null) write(`running passing queries read-only in org-${orgId} as ${ROLE} at ${CLEARANCE}`);
  try {
    for (const [i, question] of TRY_QUESTIONS.entries()) {
      write('');
      write(`question ${i + 1} of ${TRY_QUESTIONS.length} (${question.kind.replace('_', '-')}): ${question.text}`);
      const written = await writeGraphQuery(model, ROLE, question.text);
      if (!written.ok) {
        write(`  query: none`);
        write(`  passed our checks: no (${written.fallback}: ${written.code})`);
        write(`  seconds: ${seconds(written.ms)}`);
        continue;
      }
      write(`  query: ${written.query.replace(/\s+/g, ' ')}`);
      const check = checkGraphQuery(written.query);
      if (!check.ok) {
        write(`  passed our checks: no (graph_query_refused: ${check.reason}); not sent`);
        write(`  seconds: ${seconds(written.ms)}`);
        if (question.kind === 'harmful' && (check.reason === 'database_reference' || check.reason === 'write_clause')) {
          harmfulRefused += 1;
        }
        continue;
      }
      passing += 1;
      write('  passed our checks: yes');
      write(`  seconds: ${seconds(written.ms)}`);
      if (graph === null || orgId === null) continue;
      const ran = await runGraphQuery(graph, { orgId, role: ROLE, clearance: CLEARANCE }, written.query);
      if (!ran.ok) {
        write(`  ran: no (${ran.fallback}: ${ran.code}), seconds ${seconds(ran.ms)}`);
        continue;
      }
      const read = readGraphRows(ran.rows, { userId: 'try-command', role: ROLE, clearance: CLEARANCE });
      write(
        `  ran: yes, rows read ${ran.rows.length}, records ${read.records.length}, links ${read.links.length}, value rows ${read.values.length}, seconds ${seconds(ran.ms)}`,
      );
    }
  } finally {
    await graph?.close();
  }

  const harmful = TRY_QUESTIONS.filter((q) => q.kind === 'harmful').length;
  write('');
  write(`queries that passed our checks: ${passing} of ${TRY_QUESTIONS.length} (at least ${MIN_PASSING} needed)`);
  write(
    `harmful questions: ${harmful}; queries that named a database or wrote, refused before sending: ${harmfulRefused}; such queries sent: 0 (a query runs only after passing our checks)`,
  );
  const ok = passing >= MIN_PASSING;
  write(`result: ${ok ? 'pass' : 'fail'}`);
  return ok;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runTry()
    .then((ok) => {
      process.exitCode = ok ? 0 : 1;
    })
    .catch((err: unknown) => {
      // A settings or argument error names the setting or argument only.
      console.error(err instanceof Error ? err.message : 'The try command failed.');
      process.exitCode = 1;
    });
}
