// RETRIEVAL (S6-005; D6, D23, D45.3, D45.7, D46, D48, D51; S6 shared notes, "One question, step by
// step"): one search, in hybrid or vector-only mode, from the question to the ranked, filtered
// sources and the context Gemma reads.
//
// 1. Path A (VECTOR_SEARCH) and, in hybrid mode, Path B (GRAPH_SEARCH) start side by side, so Path A
//    never waits for Gemma. Path B gets the model passed in (a chat turn's session, S6-002) or, when
//    none is, the text model itself, whose one-at-a-time slot it then queues for with the questions.
//    Vector mode never calls Gemma.
// 2. Path A failing (bge-m3 can't be reached) rejects with its `AiFailure`; the caller answers
//    `assistant_unavailable`. It still waits for Path B to settle first, so a chat turn's session is
//    never left with a call running after the turn has given back the slot.
// 3. Path B failing in any way is a fallback reason, never an error: hybrid goes on with documents
//    only (D45.7). Only the caller stopping it (`AiStopped`) is passed on.
// 4. The API's own visibility check (./entity-filter.ts): each passage's document is read again in
//    Postgres, in the asker's org context, so a passage of a document that is removed, another
//    org's, or hidden from the asker is dropped; records and links are checked against the role and
//    clearance. Then RRF with k=60 (./fusion.ts), the context limits, and the two sections
//    (./context.ts).
// Logs: IDs, counts, times and codes only; never the question, a passage, a name or the query (D163).
import {
  DEFAULT_SEARCH_MODE,
  SEARCH_LIMITS,
  isGraphFallbackReason,
  isSearchMode,
  type SearchGraphPart,
} from '@grc/shared';
import { and, eq, inArray } from 'drizzle-orm';
import type { Logger } from 'pino';
import { isAiFailure, isAiStopped } from '../../ai/ai-failure.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { withOrgContext } from '../../db/org-context.js';
import { documents } from '../../intake/intake.schema.js';
import type {
  GraphQueryModel,
  GraphSearch,
  GraphSearchResult,
  Retrieval,
  RetrievalResult,
  RetrieveOptions,
  SearchCaller,
  VectorPassage,
  VectorSearch,
  VectorSearchResult,
} from '../retrieval.js';
import { buildContext } from './context.js';
import { filterVisible, type DocumentFacts } from './entity-filter.js';
import { fuseSources, selectContext } from './fusion.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HybridRetrievalDeps {
  db: Db;
  vector: VectorSearch;
  graph: GraphSearch;
  /** The text model: Path B's model when the caller passes none. */
  textModel: GraphQueryModel;
  log?: Logger;
  /** The clock, in milliseconds. */
  now?: () => number;
}

/** A time in milliseconds as the answer holds it: a finite number of at least 0. */
function ms(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export class HybridRetrieval implements Retrieval {
  private readonly db: Db;
  private readonly vector: VectorSearch;
  private readonly graph: GraphSearch;
  private readonly textModel: GraphQueryModel;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(deps: HybridRetrievalDeps) {
    this.db = deps.db;
    this.vector = deps.vector;
    this.graph = deps.graph;
    this.textModel = deps.textModel;
    this.log = (deps.log ?? createLogger()).child({ context: 'Retrieval' });
    this.now = deps.now ?? (() => performance.now());
  }

  async retrieve(caller: SearchCaller, question: string, options: RetrieveOptions): Promise<RetrievalResult> {
    const mode = options.mode ?? DEFAULT_SEARCH_MODE;
    if (!isSearchMode(mode)) throw new TypeError('retrieve: unknown search mode');

    // Both paths at once, Path A first: it never waits for Gemma. (A throw becomes a rejection.)
    const vectorRun = (async () => this.vector.search(caller, question))();
    const graphRun =
      mode === 'hybrid' ? this.runGraph(caller, question, options.model ?? this.textModel) : Promise.resolve(null);
    const [a, b] = await Promise.allSettled([vectorRun, graphRun]);

    if (b.status === 'rejected') throw b.reason; // only the caller's stop gets here (runGraph)
    if (a.status === 'rejected') {
      const err: unknown = a.reason;
      this.log.warn(
        { orgId: caller.orgId, mode, code: isAiFailure(err) ? err.code : 'error' },
        'search: the passages could not be searched',
      );
      throw err;
    }
    return this.fuse(caller, mode, a.value, b.value);
  }

  /** Path B, which never rejects: anything it throws is `graph_query_failed`, except a stop. */
  private async runGraph(caller: SearchCaller, question: string, model: GraphQueryModel): Promise<GraphSearchResult> {
    const started = this.now();
    try {
      return await this.graph.search(caller, question, model);
    } catch (err) {
      if (isAiStopped(err)) throw err;
      this.log.warn({ orgId: caller.orgId, code: 'graph_query_failed' }, 'search: the graph path threw');
      return {
        ok: false,
        fallback: 'graph_query_failed',
        query: null,
        timings: { writingMs: ms(this.now() - started), runningMs: null },
      };
    }
  }

  private async fuse(
    caller: SearchCaller,
    mode: RetrievalResult['mode'],
    pathA: VectorSearchResult,
    pathB: GraphSearchResult | null,
  ): Promise<RetrievalResult> {
    const started = this.now();
    const viewer = { role: caller.role, clearance: caller.clearance };
    const passagesFound = Array.isArray(pathA.passages) ? pathA.passages : [];
    const graphOk = pathB !== null && pathB.ok ? pathB : null;

    const docs = await this.documentFacts(caller, passagesFound);
    const filtered = filterVisible(viewer, caller.orgId, {
      passages: passagesFound,
      records: graphOk?.records ?? [],
      links: graphOk?.links ?? [],
      documents: docs,
    });
    const fused = fuseSources(filtered.passages, graphOk !== null ? filtered.records : null);
    const selection = selectContext(fused, filtered.links);
    const built = buildContext(selection, graphOk?.values ?? [], caller.clearance, SEARCH_LIMITS.searchResults);

    const graph = graphPart(mode, pathB);
    const fusionMs = ms(this.now() - started);
    const timings = {
      embeddingMs: ms(pathA.timings?.embeddingMs),
      vectorSearchMs: ms(pathA.timings?.searchMs),
      queryWritingMs: pathB !== null ? ms(pathB.timings?.writingMs) : null,
      queryRunningMs:
        pathB !== null && typeof pathB.timings?.runningMs === 'number' ? ms(pathB.timings.runningMs) : null,
      fusionMs,
    };

    const { dropped } = filtered;
    if (dropped.passages > 0 || dropped.records > 0 || dropped.links > 0) {
      this.log.warn({ orgId: caller.orgId, mode, dropped }, 'search: the last check dropped findings');
    }
    const keptPassages = selection.kept.filter((e) => e.item.type === 'passage').length;
    this.log.info(
      {
        orgId: caller.orgId,
        principal: caller.kind,
        mode,
        found: {
          passages: passagesFound.length,
          records: graphOk?.records.length ?? 0,
          links: graphOk?.links.length ?? 0,
        },
        kept: {
          passages: keptPassages,
          records: selection.kept.length - keptPassages,
          links: selection.links.length,
        },
        results: built.results.length,
        graphRan: graph.ran,
        fallback: graph.fallback,
        rowsRead: graph.rowsRead,
        label: built.label,
        timings,
      },
      'search retrieved',
    );

    return {
      mode,
      results: built.results,
      sources: built.sources,
      context: built.context,
      graph,
      label: built.label,
      timings,
    };
  }

  /** Each passage's document as the asker sees it in Postgres: only their own org's, under row
   * security (the role views its record type, its label at or below the clearance). */
  private async documentFacts(
    caller: SearchCaller,
    passages: readonly VectorPassage[],
  ): Promise<Map<string, DocumentFacts>> {
    const ids = [...new Set(passages.map((p) => p.documentId))].filter(
      (id): id is string => typeof id === 'string' && UUID.test(id),
    );
    if (ids.length === 0) return new Map();
    const ctx = { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
    const rows = await withOrgContext(this.db, ctx, (tx) =>
      tx
        .select({
          id: documents.id,
          orgId: documents.orgId,
          recordType: documents.recordType,
          label: documents.label,
          status: documents.status,
        })
        .from(documents)
        .where(and(eq(documents.orgId, caller.orgId), inArray(documents.id, ids))),
    );
    return new Map(rows.map((row) => [row.id, row]));
  }
}

/** The graph part of the answer: never ran in vector mode; the query, rows or fallback in hybrid. */
function graphPart(mode: RetrievalResult['mode'], pathB: GraphSearchResult | null): SearchGraphPart {
  if (mode === 'vector' || pathB === null) return { ran: false, query: null, fallback: null, rowsRead: 0 };
  const query = typeof pathB.query === 'string' && pathB.query !== '' ? pathB.query : null;
  if (pathB.ok) {
    const rows = Number.isInteger(pathB.rowsRead) ? pathB.rowsRead : 0;
    return { ran: true, query, fallback: null, rowsRead: Math.min(Math.max(rows, 0), SEARCH_LIMITS.graphRows) };
  }
  const fallback = isGraphFallbackReason(pathB.fallback) ? pathB.fallback : 'graph_query_failed';
  return { ran: false, query, fallback, rowsRead: 0 };
}
