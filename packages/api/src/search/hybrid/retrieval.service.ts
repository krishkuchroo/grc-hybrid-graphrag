// RETRIEVAL (S6-005; D6, D23, D45.3, D45.7, D46, D48, D51; S6 shared notes, "One question, step by
// step"): one search, in hybrid or vector-only mode, from the question to the ranked, filtered
// sources and the context Gemma reads.
//
// 1. Path A (VECTOR_SEARCH) and, in hybrid mode, Path B (GRAPH_SEARCH) start side by side, so Path A
//    never waits for Gemma. Path B gets the model passed in (a chat turn's session, S6-002) or, when
//    none is, the text model itself, whose one-at-a-time slot it then queues for with the questions.
//    Vector mode never calls Gemma. In hybrid mode the named record finder (../named/, FX-003)
//    starts beside them; vector mode never calls it.
// 2. Path A failing (bge-m3 can't be reached) rejects with its `AiFailure`; the caller answers
//    `assistant_unavailable`. It still waits for Path B to settle first, so a chat turn's session is
//    never left with a call running after the turn has given back the slot.
// 3. Path B failing in any way is a fallback reason, never an error: hybrid goes on with documents
//    only (D45.7). Only the caller stopping it (`AiStopped`) is passed on. The finder failing gives
//    no named records.
// 3a. When Path B ran, the named records it didn't find itself follow its records, before the
//    entity filter and fusion, so they reach `<GRAPH_CONTEXT>` (they rank after Path B's own; no
//    links are added for them). When it failed they stay out of the context (D45.7) but are still
//    listed in `namedRecords`, after the entity filter's record check.
// 4. The API's own visibility check (./entity-filter.ts): each passage's document is read again in
//    Postgres, in the asker's org context, so a passage of a document that is removed, another
//    org's, or hidden from the asker is dropped; records and links are checked against the role and
//    clearance. Then RRF with k=60 (./fusion.ts), the context limits (15 passages within a token
//    budget set by the text model's context, and 30 records, D260), a clear document's other
//    chunks (./clear-document.ts, up to 24 passages in all), and the two sections (./context.ts).
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
  GraphRecord,
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
import type { NamedRecord, NamedRecordFinder } from '../named/named-records.js';
import { filterVisible, recordVisible, type DocumentFacts } from './entity-filter.js';
import { addDocumentChunks, clearDocumentOf, readDocumentChunks } from './clear-document.js';
import { contextLimitsFor, fuseSources, selectContext, type ContextLimits, type ContextSelection } from './fusion.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface HybridRetrievalDeps {
  db: Db;
  vector: VectorSearch;
  graph: GraphSearch;
  /** The records a question names (hybrid mode only, FX-003). */
  named: NamedRecordFinder;
  /** The text model: Path B's model when the caller passes none. */
  textModel: GraphQueryModel;
  /** The text model's context in tokens (`TextModel.contextTokens`), which sets the passages'
   * token budget (D260). */
  contextTokens: number;
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
  private readonly named: NamedRecordFinder;
  private readonly textModel: GraphQueryModel;
  private readonly limits: ContextLimits;
  private readonly log: Logger;
  private readonly now: () => number;

  constructor(deps: HybridRetrievalDeps) {
    this.db = deps.db;
    this.vector = deps.vector;
    this.graph = deps.graph;
    this.named = deps.named;
    this.textModel = deps.textModel;
    this.limits = contextLimitsFor(deps.contextTokens);
    this.log = (deps.log ?? createLogger()).child({ context: 'Retrieval' });
    this.now = deps.now ?? (() => performance.now());
  }

  async retrieve(caller: SearchCaller, question: string, options: RetrieveOptions): Promise<RetrievalResult> {
    const mode = options.mode ?? DEFAULT_SEARCH_MODE;
    if (!isSearchMode(mode)) throw new TypeError('retrieve: unknown search mode');

    // Both paths at once, Path A first: it never waits for Gemma. (A throw becomes a rejection.) The
    // named record finder starts beside them in hybrid mode and never rejects (runNamed).
    const vectorRun = (async () => this.vector.search(caller, question))();
    const graphRun =
      mode === 'hybrid' ? this.runGraph(caller, question, options.model ?? this.textModel) : Promise.resolve(null);
    const namedRun = mode === 'hybrid' ? this.runNamed(caller, question) : Promise.resolve([]);
    const [a, b, n] = await Promise.allSettled([vectorRun, graphRun, namedRun]);

    if (b.status === 'rejected') throw b.reason; // only the caller's stop gets here (runGraph)
    if (a.status === 'rejected') {
      const err: unknown = a.reason;
      this.log.warn(
        { orgId: caller.orgId, mode, code: isAiFailure(err) ? err.code : 'error' },
        'search: the passages could not be searched',
      );
      throw err;
    }
    return this.fuse(caller, mode, a.value, b.value, n.status === 'fulfilled' ? n.value : []);
  }

  /** The named record finder, which never rejects here: anything it throws gives none. */
  private async runNamed(caller: SearchCaller, question: string): Promise<NamedRecord[]> {
    try {
      const found = await this.named.find(caller, question);
      return Array.isArray(found) ? found : [];
    } catch {
      this.log.warn({ orgId: caller.orgId, code: 'named_records_failed' }, 'search: the named records threw');
      return [];
    }
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
    named: readonly NamedRecord[],
  ): Promise<RetrievalResult> {
    const started = this.now();
    const viewer = { role: caller.role, clearance: caller.clearance };
    const passagesFound = Array.isArray(pathA.passages) ? pathA.passages : [];
    const graphOk = pathB !== null && pathB.ok ? pathB : null;

    // The named records Path B didn't find follow its records (only when it ran, D45.7).
    const namedFound = named.map((n) => n.record);
    const graphRecords: GraphRecord[] = graphOk !== null ? [...graphOk.records] : [];
    if (graphOk !== null) {
      const ids = new Set(graphRecords.map((r) => r.id));
      for (const record of namedFound) {
        if (ids.has(record.id)) continue;
        ids.add(record.id);
        graphRecords.push(record);
      }
    }
    const namedRecords = namedFound
      .filter((record) => recordVisible(viewer, record))
      .map(({ id, kind, number, name }) => ({ id, kind, number, name }));

    const docs = await this.documentFacts(caller, passagesFound);
    const filtered = filterVisible(viewer, caller.orgId, {
      passages: passagesFound,
      records: graphRecords,
      links: graphOk?.links ?? [],
      documents: docs,
    });
    const fused = fuseSources(filtered.passages, graphOk !== null ? filtered.records : null);
    const fusedSelection = selectContext(fused, filtered.links, this.limits);
    const { selection, added } = await this.withClearDocument(caller, fusedSelection);
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
    const keptRecordIds = new Set(selection.kept.flatMap((e) => (e.item.type === 'record' ? [e.item.record.id] : [])));
    const passageRecordIds = [
      ...new Set(
        selection.kept.flatMap((e) =>
          e.item.type === 'passage' ? e.item.passage.recordIds.filter((id) => typeof id === 'string') : [],
        ),
      ),
    ];
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
          fromClearDocument: added,
          passageTokens: selection.passageTokens,
          records: selection.kept.length - keptPassages,
          links: selection.links.length,
        },
        results: built.results.length,
        named: {
          found: named.length,
          kept: namedRecords.length,
          inContext: namedRecords.filter((r) => keptRecordIds.has(r.id)).length,
        },
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
      namedRecords,
      passageRecordIds,
    };
  }

  /** The selection with its clear document's other chunks added, when one document clearly matches
   * (./clear-document.ts); unchanged when none does or there is no room. */
  private async withClearDocument(
    caller: SearchCaller,
    selection: ContextSelection,
  ): Promise<{ selection: ContextSelection; added: number }> {
    const documentId = clearDocumentOf(selection.kept);
    if (documentId === null) return { selection, added: 0 };
    const keptChunkIds = selection.kept.flatMap((e) => (e.item.type === 'passage' ? [e.item.passage.chunkId] : []));
    const room = SEARCH_LIMITS.contextPassagesMax - keptChunkIds.length;
    if (room < 1 || selection.passageTokens >= this.limits.passageTokens) return { selection, added: 0 };
    const more = await readDocumentChunks(this.db, caller, documentId, keptChunkIds, room);
    return addDocumentChunks(selection, more, this.limits);
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
