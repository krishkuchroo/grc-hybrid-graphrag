// Path B, the AI-written graph query (S6-004; D15, D22, D45.3, D45.6, D45.7, D52.1-D52.3, D131,
// D163, SF-049). `GRAPH_SEARCH` (../retrieval.ts):
// 1. Writing: the model passed in (a Gemma turn's session, S6-002, or the text model itself; this
//    part never makes its own) writes one query from the question, with the graph described for
//    the asker's role only (./prompt.ts), within 60 s.
// 2. Checking: our checks refuse anything but one read-only query that stays in the org's own
//    database and reads no hidden property (./query-check.ts). Nothing refused is ever sent.
// 3. Running: `GraphService.readAs` runs it in `org-<orgId>` as the asker's role x clearance
//    read-only account (D52.2, D73), and Neo4j stops it after 5 s. At most 50 rows are read; the
//    rest are discarded on the server.
// 4. Results: records, links and plain values, checked again against the asker's access, links
//    kept only with both ends, AI-link sources only for those cleared for them (./graph-results.ts).
// Every failure is a fallback reason, never an error (D45.7): `graph_model_unavailable`,
// `graph_query_invalid`, `graph_query_refused`, `graph_query_timed_out`, `graph_query_failed`.
// Logs (D163): codes, times and counts only; never the question, the query or any value.
import { SEARCH_LIMITS, isLabel, isRole, type GraphFallbackReason, type Label, type Role } from '@grc/shared';
import type { ManagedTransaction } from 'neo4j-driver';
import type { Logger } from 'pino';
import { isAiFailure } from '../../ai/ai-failure.js';
import { createLogger } from '../../common/logger.js';
import { GraphQueryRefused } from '../../graph/query-guard.js';
import type { GraphService } from '../../graph/graph.service.js';
import type {
  GraphQueryModel,
  GraphSearch,
  GraphSearchFailed,
  GraphSearchResult,
  GraphSearchTimings,
  SearchCaller,
} from '../retrieval.js';
import { readGraphRows, type GraphRow } from './graph-results.js';
import { GRAPH_QUERY_PROMPT_VERSION, cleanQuery, graphQueryRequest } from './prompt.js';
import { checkGraphQuery } from './query-check.js';

/** The slice of GraphService Path B needs: a read as the role x clearance account. */
export type GraphReader = Pick<GraphService, 'readAs'>;

export interface GraphQueryLimits {
  /** Neo4j stops the query after this long, in milliseconds. */
  timeoutMs: number;
  /** The most rows read. */
  maxRows: number;
}

export const GRAPH_QUERY_LIMITS: GraphQueryLimits = Object.freeze({
  timeoutMs: SEARCH_LIMITS.graphQueryTimeoutMs,
  maxRows: SEARCH_LIMITS.graphRows,
});

/**
 * Past Neo4j's own limit by this long, the run is given up as timed out (fail safe): a connection
 * that hangs, or the driver retrying an unreachable Neo4j, never holds the question up for long.
 */
const GIVE_UP_AFTER_MS = 3_000;

const LOWERCASE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** What the model wrote, or why it wrote nothing usable. */
export type WrittenQuery =
  | { ok: true; query: string; model: string; ms: number }
  | { ok: false; fallback: 'graph_model_unavailable' | 'graph_query_invalid'; code: string; ms: number };

/** What running the query gave: its first rows, or why it failed. */
export type RanQuery =
  | { ok: true; rows: GraphRow[]; ms: number }
  | {
      ok: false;
      fallback: 'graph_query_timed_out' | 'graph_query_failed' | 'graph_query_refused';
      code: string;
      ms: number;
    };

function since(start: number): number {
  return Math.round(performance.now() - start);
}

/** A failure's type or code, never its message (a driver or SDK message can quote the query). */
function codeOf(err: unknown): string {
  if (isAiFailure(err)) return err.code;
  if (typeof err === 'object' && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Za-z0-9_.]{1,120}$/.test(code)) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === 'string' && /^\w{1,60}$/.test(name)) return name;
  }
  return 'error';
}

function isTimeout(err: unknown, ms: number, timeoutMs: number): boolean {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  if (typeof code !== 'string') return false;
  if (/TransactionTimedOut/i.test(code)) return true;
  // A transaction Neo4j ended at the time limit can also be reported as terminated.
  return /Transaction\.(?:Terminated|LockClientStopped)/i.test(code) && ms >= timeoutMs;
}

/** Asks the model for one query, for the asker's role. Never rejects. */
export async function writeGraphQuery(model: GraphQueryModel, role: Role, question: string): Promise<WrittenQuery> {
  const started = performance.now();
  try {
    const answer = await model.generate(graphQueryRequest(role, question));
    const query = cleanQuery(answer.value.query);
    if (query === '') return { ok: false, fallback: 'graph_query_invalid', code: 'empty', ms: since(started) };
    return { ok: true, query, model: answer.model, ms: since(started) };
  } catch (err) {
    const fallback = isAiFailure(err, 'invalid_output') ? 'graph_query_invalid' : 'graph_model_unavailable';
    return { ok: false, fallback, code: codeOf(err), ms: since(started) };
  }
}

/**
 * Runs a checked query in `org-<orgId>` as the read-only account for `role` and `clearance`,
 * stopped by Neo4j after `limits.timeoutMs`, reading at most `limits.maxRows` rows. Never rejects.
 * The caller checks the query first (`checkGraphQuery`); this sends it as it is.
 */
export async function runGraphQuery(
  graph: GraphReader,
  where: { orgId: string; role: Role; clearance: Label },
  query: string,
  limits: GraphQueryLimits = GRAPH_QUERY_LIMITS,
): Promise<RanQuery> {
  const started = performance.now();
  const read = async (tx: ManagedTransaction): Promise<GraphRow[]> => {
    const rows: GraphRow[] = [];
    // Leaving the loop early discards the rest of the result on the server.
    for await (const record of tx.run(query)) {
      rows.push({ keys: [...record.keys].map(String), values: record.keys.map((key) => record.get(key) as unknown) });
      if (rows.length >= limits.maxRows) break;
    }
    return rows;
  };
  const running = graph.readAs(where.orgId, where.role, where.clearance, read, { timeoutMs: limits.timeoutMs });
  let timer: NodeJS.Timeout | undefined;
  const givenUp = new Promise<'given_up'>((resolve) => {
    timer = setTimeout(() => resolve('given_up'), limits.timeoutMs + GIVE_UP_AFTER_MS);
  });
  try {
    const outcome = await Promise.race([running, givenUp]);
    if (outcome === 'given_up') {
      // Neo4j stops the transaction itself; whatever it settles with later is ignored.
      running.catch(() => undefined);
      return { ok: false, fallback: 'graph_query_timed_out', code: 'given_up', ms: since(started) };
    }
    return { ok: true, rows: outcome, ms: since(started) };
  } catch (err) {
    const ms = since(started);
    if (err instanceof GraphQueryRefused)
      return { ok: false, fallback: 'graph_query_refused', code: 'database_reference', ms };
    if (isTimeout(err, ms, limits.timeoutMs))
      return { ok: false, fallback: 'graph_query_timed_out', code: codeOf(err), ms };
    return { ok: false, fallback: 'graph_query_failed', code: codeOf(err), ms };
  } finally {
    clearTimeout(timer);
  }
}

export interface GraphSearchDeps {
  graph: GraphReader;
  log?: Logger;
  limits?: GraphQueryLimits;
}

export class GraphSearchService implements GraphSearch {
  private readonly graph: GraphReader;
  private readonly log: Logger;
  private readonly limits: GraphQueryLimits;

  constructor(deps: GraphSearchDeps) {
    this.graph = deps.graph;
    this.log = (deps.log ?? createLogger()).child({ context: 'GraphSearch' });
    this.limits = deps.limits ?? GRAPH_QUERY_LIMITS;
  }

  async search(caller: SearchCaller, question: string, model: GraphQueryModel): Promise<GraphSearchResult> {
    const started = performance.now();
    try {
      return await this.searchOnce(caller, question, model);
    } catch (err) {
      // Nothing above throws on purpose; anything that does is a fallback too (D45.7).
      const timings = { writingMs: since(started), runningMs: null };
      this.log.error({ code: codeOf(err), ...timings }, 'graph search failed');
      return { ok: false, fallback: 'graph_query_failed', query: null, timings };
    }
  }

  private async searchOnce(caller: SearchCaller, question: string, model: GraphQueryModel): Promise<GraphSearchResult> {
    const { orgId, role, clearance, userId } = caller ?? ({} as Partial<SearchCaller>);
    if (
      typeof orgId !== 'string' ||
      !LOWERCASE_UUID.test(orgId) ||
      !isRole(role) ||
      !isLabel(clearance) ||
      typeof userId !== 'string' ||
      typeof question !== 'string' ||
      question.trim() === '' ||
      typeof model?.generate !== 'function'
    ) {
      // Never reached through the routes, which check all of these; fail safe all the same.
      this.log.warn({ code: 'bad_input' }, 'graph search not run');
      return { ok: false, fallback: 'graph_query_failed', query: null, timings: { writingMs: 0, runningMs: null } };
    }

    const written = await writeGraphQuery(model, role, question);
    if (!written.ok) {
      return this.fellBack(written.fallback, null, { writingMs: written.ms, runningMs: null }, { code: written.code });
    }
    const { query } = written;

    const check = checkGraphQuery(query);
    if (!check.ok) {
      return this.fellBack(
        'graph_query_refused',
        query,
        { writingMs: written.ms, runningMs: null },
        { code: check.reason },
      );
    }

    const ran = await runGraphQuery(this.graph, { orgId, role, clearance }, query, this.limits);
    const timings: GraphSearchTimings = { writingMs: written.ms, runningMs: ran.ms };
    if (!ran.ok) return this.fellBack(ran.fallback, query, timings, { code: ran.code });

    const read = readGraphRows(ran.rows, { userId, role, clearance });
    this.log.info(
      {
        model: written.model,
        promptVersion: GRAPH_QUERY_PROMPT_VERSION,
        rowsRead: ran.rows.length,
        records: read.records.length,
        links: read.links.length,
        valueRows: read.values.length,
        droppedRecords: read.droppedRecords,
        droppedLinks: read.droppedLinks,
        ...timings,
      },
      'graph search ran',
    );
    return {
      ok: true,
      query,
      records: read.records,
      links: read.links,
      values: read.values,
      rowsRead: ran.rows.length,
      timings,
    };
  }

  private fellBack(
    fallback: GraphFallbackReason,
    query: string | null,
    timings: GraphSearchTimings,
    detail: { code: string },
  ): GraphSearchFailed {
    this.log.warn(
      { fallback, code: detail.code, promptVersion: GRAPH_QUERY_PROMPT_VERSION, ...timings },
      'graph search fell back',
    );
    return { ok: false, fallback, query, timings };
  }
}
