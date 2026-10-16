// The search and chat limits (S6 shared notes, "Limits"), as named constants. S8 tunes them, as S4's
// cut-offs. Times are in milliseconds.

export const SEARCH_LIMITS = Object.freeze({
  /** Path A: the passages vector search returns, closest first. */
  vectorPassages: 20,
  /** Path B: the most rows read from one graph query. */
  graphRows: 50,
  /** Path B: Neo4j stops the graph query after this long. */
  graphQueryTimeoutMs: 5_000,
  /** Path B: the time Gemma has to write the graph query. */
  graphQueryWritingTimeoutMs: 60_000,
  /** Path B: the longest graph query Gemma may write, in characters. */
  graphQueryMaxLength: 2_000,
  /** RRF's k (the spec's algorithm, D6). */
  rrfK: 60,
  /** The context: at most this many passages… */
  contextPassages: 5,
  /** …and this many records. */
  contextRecords: 30,
  /** `POST /api/v1/search`: the most results it lists. */
  searchResults: 50,
  /** The answer: at most this many tokens… */
  answerMaxTokens: 1_024,
  /** …and stopped after this long. */
  answerTimeoutMs: 180_000,
  /** A question: trimmed, then 1 to this many characters. */
  questionMaxLength: 2_000,
  /** A conversation's title: the first this many characters of its first question. */
  conversationTitleLength: 80,
});
