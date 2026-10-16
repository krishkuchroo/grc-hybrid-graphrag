// Why the graph path (Path B) gave nothing (D45.7; S6 shared notes, "One question, step by step"): a
// fallback reason, never an error to the asker. The answer then uses documents only and says so.
// - `graph_model_unavailable`: Gemma couldn't be reached, or didn't write the query in time.
// - `graph_query_invalid`: Gemma's answer didn't pass the query schema.
// - `graph_query_refused`: our checks refused the query before it was sent.
// - `graph_query_timed_out`: Neo4j stopped the query at the time limit.
// - `graph_query_failed`: the query failed in any other way.

export const GRAPH_FALLBACK_REASONS = [
  'graph_model_unavailable',
  'graph_query_invalid',
  'graph_query_refused',
  'graph_query_timed_out',
  'graph_query_failed',
] as const;
export type GraphFallbackReason = (typeof GRAPH_FALLBACK_REASONS)[number];

export function isGraphFallbackReason(v: unknown): v is GraphFallbackReason {
  return typeof v === 'string' && (GRAPH_FALLBACK_REASONS as readonly string[]).includes(v);
}
