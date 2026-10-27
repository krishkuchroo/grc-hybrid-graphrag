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
  /** The context: at most this many passages from the fused list (D260)… */
  contextPassages: 15,
  /** …and at most this many passages in all, a clear document's other chunks included (D260)… */
  contextPassagesMax: 24,
  /** …and this many records. */
  contextRecords: 30,
  /** The most tokens the context's passages may hold, counted in the chunks' stored bge-m3 token
   * counts (D260); a text model with a smaller context gets less (the budget in fusion.ts). */
  contextPassageTokens: 11_000,
  /** The tokens of the text model's context kept free for the instructions, the question, the
   * records and the section markers (D260). */
  contextReserveTokens: 4_000,
  /** A clear document (D260, Q-ASK-4): one that holds at least `clearDocumentShare` of the first
   * `clearDocumentLead` kept passages, and more of them than any other document. */
  clearDocumentLead: 5,
  clearDocumentShare: 3,
  /** The "Not reviewed yet" list (D260, Q-ASK-5): at most this many pending link findings shown… */
  pendingLinks: 50,
  /** …chosen from at most this many pending link findings, newest first. */
  pendingLinkCandidates: 5_000,
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
