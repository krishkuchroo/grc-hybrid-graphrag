// Plain words for the chat panel (D2, screen 9; S6 shared notes), so the API, the web app and the
// benchmark say the same thing: the steps, the queue, the documents-only notice, nothing found,
// unavailable, stopped, hidden, a source that can't be seen any more, a new conversation's title and
// rate limited.
import type { GraphFallbackReason } from '../search/fallback.js';
import type { SearchMode } from '../search/modes.js';
import type { ChatStep } from './stream.js';

export const CHAT_STEP_TEXT: Readonly<Record<ChatStep, string>> = Object.freeze({
  searching_documents: 'Searching documents',
  querying_graph: 'Querying the graph',
  writing_answer: 'Writing the answer',
});

export const CHAT_TEXT = Object.freeze({
  /** Above an answer whose graph path failed (D45.7). */
  documentsOnly: "The graph search didn't work this time, so this answer uses documents only.",
  /** The answer when no source was found; Gemma isn't asked (S6-Q6). */
  nothingFound: "I couldn't find anything about that in what you can see.",
  /** Gemma or bge-m3 can't be reached. */
  unavailable: 'The assistant is unavailable right now. Try again in a minute.',
  /** An answer the person stopped, or cut at its time or length limit. */
  stopped: 'Stopped',
  /** A message above the reader's current clearance (S6-Q9). */
  hidden: "This answer used sources above your current clearance, so it's hidden.",
  /** A citation the reader can't see any more. */
  sourceHidden: 'A source you can no longer see',
  /** A conversation's title until its first question names it. */
  newConversation: 'New conversation',
});

/** Why the graph path fell back, in plain words. */
export const GRAPH_FALLBACK_TEXT: Readonly<Record<GraphFallbackReason, string>> = Object.freeze({
  graph_model_unavailable: "The model that writes graph queries couldn't be reached.",
  graph_query_invalid: "The graph query wasn't written in the expected form.",
  graph_query_refused: "The graph query didn't pass the safety checks, so it wasn't run.",
  graph_query_timed_out: 'The graph query took too long and was stopped.',
  graph_query_failed: 'The graph query failed.',
});

export const SEARCH_MODE_TEXT: Readonly<Record<SearchMode, string>> = Object.freeze({
  hybrid: 'Documents and graph',
  vector: 'Documents only',
});

function wholeAtLeastOne(n: number): number {
  return Number.isFinite(n) ? Math.max(1, Math.ceil(n)) : 1;
}

/** "You're number N in the queue" (1 means next). */
export function queuePositionText(position: number): string {
  return `You're number ${wholeAtLeastOne(position)} in the queue`;
}

/** Over the 10-a-minute limit (D64): "try again in N s". */
export function rateLimitedText(seconds: number): string {
  return `Too many questions, try again in ${wholeAtLeastOne(seconds)} s.`;
}

/** The words for a step; anything unknown is shown as it is. */
export function chatStepText(step: string): string {
  return Object.hasOwn(CHAT_STEP_TEXT, step) ? CHAT_STEP_TEXT[step as ChatStep] : step;
}

/** The words for a fallback reason; anything unknown is shown as it is. */
export function graphFallbackText(reason: string): string {
  return Object.hasOwn(GRAPH_FALLBACK_TEXT, reason) ? GRAPH_FALLBACK_TEXT[reason as GraphFallbackReason] : reason;
}
