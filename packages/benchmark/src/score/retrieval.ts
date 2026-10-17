// Scoring one search answer (`POST /api/v1/search`) against a question's expected records (S8-004;
// S8-001's retrieval metrics), the same way in hybrid and vector mode (D1, D46).
// - A result holds an expected record when it is that record (a record result with its ID or number)
//   or names it (a passage whose text names it by number or name, `namesRecord`).
// - `context_recall`: the share of the expected records an in-context result holds; `result_recall`:
//   the same over every result; `reciprocal_rank`: 1 over the rank of the first result that holds
//   one, 0 when none does; `graph_query_ran` (hybrid only): 1 when the graph query ran.
// - The times: embedding, vector search, and in hybrid mode writing the graph query and (when it
//   ran) running it.
// - The details: the question, the expected records, the ones found with their best rank and whether
//   one was in the context, the first matching rank, the graph part (ran, query, fallback reason)
//   and the timings.
// - Outcome: `pass` when context recall is 1, `partial` above 0, `fail` at 0. A `no_answer` question
//   (or one with no expected records) is `skipped` (`no_expected_records`), its times kept.
// Pure: no I/O, no clock, no randomness; the same inputs always give the same item.
import {
  BENCHMARK_LIMITS,
  normaliseName,
  type BenchmarkFoundRecord,
  type BenchmarkGraphDetail,
  type BenchmarkOutcome,
  type BenchmarkQuestion,
  type BenchmarkTimings,
  type SearchAnswer,
  type SearchGraphPart,
  type SearchResult,
  type SearchTimings,
} from '@grc/shared';
import {
  expectedDetails,
  expectedOf,
  injectionDetail,
  isExpectedRecord,
  itemMetrics,
  msOrNull,
  share,
  textNamesExpected,
  type ExpectedMatcher,
  type ResolvedExpectedRecord,
  type RetrievalResultItem,
} from './common.js';
import { storableText } from './text.js';

/** The graph part as an item's details hold it. */
function graphDetail(graph: SearchGraphPart): BenchmarkGraphDetail {
  return {
    ran: graph.ran === true,
    query: typeof graph.query === 'string' ? storableText(graph.query) : null,
    fallback: graph.fallback ?? null,
  };
}

/** A search's timings as an item's details hold them; a search has no wait, first words or total. */
function searchTimings(timings: SearchTimings): BenchmarkTimings {
  return {
    embeddingMs: msOrNull(timings.embeddingMs),
    vectorSearchMs: msOrNull(timings.vectorSearchMs),
    queryWritingMs: msOrNull(timings.queryWritingMs),
    queryRunningMs: msOrNull(timings.queryRunningMs),
    fusionMs: msOrNull(timings.fusionMs),
    waitedMs: null,
    firstWordsMs: null,
    totalMs: null,
  };
}

/** Whether the result holds the expected record: it is that record, or a passage naming it. */
function resultHolds(result: SearchResult, normalisedPassage: string | null, expected: ExpectedMatcher): boolean {
  if (result.type === 'record') return isExpectedRecord(result.record, expected);
  return normalisedPassage !== null && textNamesExpected(normalisedPassage, expected);
}

interface Hit {
  rank: number | null;
  inContext: boolean;
}

/**
 * One search answer scored against the question's expected records, resolved to the org's records
 * (ID, number, name, kind). Gives the retrieval item for the answer's mode.
 */
export function scoreRetrieval(
  question: BenchmarkQuestion,
  expected: readonly ResolvedExpectedRecord[],
  answer: SearchAnswer,
): RetrievalResultItem {
  const mode = answer.mode;
  const records = expectedOf(question, expected);
  const graph = graphDetail(answer.graph);
  const timings = searchTimings(answer.timings);
  const hybrid = mode === 'hybrid';
  const times = {
    embedding_ms: timings.embeddingMs,
    vector_search_ms: timings.vectorSearchMs,
    graph_query_writing_ms: hybrid ? timings.queryWritingMs : null,
    graph_query_running_ms: hybrid && graph.ran ? timings.queryRunningMs : null,
  };
  const base = {
    itemKey: question.id,
    part: 'retrieval' as const,
    mode,
    kind: question.kind,
  };
  const detailsBase = {
    referenceId: null,
    question: storableText(question.text),
    expected: expectedDetails(records),
    graph,
    timings,
    answer: null,
    injection: injectionDetail(question, null),
  };

  if (records.length === 0) {
    return {
      ...base,
      outcome: 'skipped',
      metrics: itemMetrics('retrieval', mode, question.kind, times),
      details: { ...detailsBase, reason: 'no_expected_records', found: [], firstMatchRank: null },
    };
  }

  const hits: Hit[] = records.map(() => ({ rank: null, inContext: false }));
  let firstMatchRank: number | null = null;
  for (const result of Array.isArray(answer.results) ? answer.results : []) {
    const normalisedPassage = result.type === 'passage' ? normaliseName(result.passage.text) : null;
    let holdsAny = false;
    for (let i = 0; i < records.length; i++) {
      const hit = hits[i];
      if (hit === undefined || !resultHolds(result, normalisedPassage, records[i]!)) continue;
      holdsAny = true;
      if (hit.rank === null || result.rank < hit.rank) hit.rank = result.rank;
      if (result.inContext) hit.inContext = true;
    }
    if (holdsAny && (firstMatchRank === null || result.rank < firstMatchRank)) firstMatchRank = result.rank;
  }

  const inResults = hits.filter((h) => h.rank !== null).length;
  const inContext = hits.filter((h) => h.inContext).length;
  const contextRecall = share(inContext, records.length) ?? 0;
  const found: BenchmarkFoundRecord[] = [];
  records.forEach(({ record }, i) => {
    const rank = hits[i]?.rank ?? null;
    if (rank === null) return;
    found.push({
      number: record.number,
      name: storableText(record.name),
      kind: record.kind,
      rank,
      inContext: hits[i]?.inContext === true,
    });
  });

  const outcome: BenchmarkOutcome = contextRecall === 1 ? 'pass' : contextRecall > 0 ? 'partial' : 'fail';
  return {
    ...base,
    outcome,
    metrics: itemMetrics('retrieval', mode, question.kind, {
      context_recall: contextRecall,
      result_recall: share(inResults, records.length),
      reciprocal_rank: firstMatchRank === null ? 0 : 1 / firstMatchRank,
      graph_query_ran: hybrid ? (graph.ran ? 1 : 0) : null,
      ...times,
    }),
    details: {
      ...detailsBase,
      reason: null,
      found: found.slice(0, BENCHMARK_LIMITS.expectedPerQuestion),
      firstMatchRank,
    },
  };
}
