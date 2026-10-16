// The chat's names (D45.8, D47, D56, D69, D186; S6 shared notes, "Audit" and "Prompts"): the audit
// action, the target type of its entry, the prompt versions and the error codes.
// - `chat.asked`: one entry per question, answered, stopped or failed, written in Postgres in the
//   transaction that saves the message, with the message as its target. `after` holds the
//   question's words (S6-Q5); `meta` holds the mode, whether the graph path ran or why it fell back,
//   the cited records (IDs and numbers), the cited documents (IDs) and the message's label, so the
//   audit viewer can hide the contents from readers below it (D186). Searches aren't audited (S6-Q7).
// - Error messages never hold a question, an answer or a record's name.
import { z } from 'zod';
import { LABELS } from '../access/labels.js';
import { searchRecordNumberSchema } from '../search/answers.js';
import { searchModeSchema } from '../search/bodies.js';
import { GRAPH_FALLBACK_REASONS } from '../search/fallback.js';
import { CHAT_TEXT } from './words.js';

export const CHAT_AUDIT_ACTIONS = Object.freeze({
  asked: 'chat.asked',
} as const);

export type ChatAuditAction = (typeof CHAT_AUDIT_ACTIONS)[keyof typeof CHAT_AUDIT_ACTIONS];

/** The `targetType` of a `chat.asked` entry; its `targetId` is the message's ID. */
export const CHAT_MESSAGE_TARGET_TYPE = 'chat_message';

/** A `chat.asked` entry's meta. */
export const chatAskedMetaSchema = z.object({
  mode: searchModeSchema,
  /** True when the graph query ran (hybrid only). */
  graphRan: z.boolean(),
  /** Why the graph path fell back, when it did. */
  fallback: z.enum(GRAPH_FALLBACK_REASONS).nullable(),
  citedRecords: z.array(z.object({ id: z.uuid(), number: searchRecordNumberSchema })),
  citedDocuments: z.array(z.uuid()),
  label: z.enum(LABELS),
});

export type ChatAskedMeta = z.infer<typeof chatAskedMetaSchema>;

/** The versioned prompts (D45.8), recorded with every message. */
export const CHAT_PROMPT_VERSIONS = Object.freeze({
  graphQuery: 'chat-graph-query-v1',
  answer: 'chat-answer-v1',
} as const);

export interface ChatError {
  status: 400 | 404 | 429 | 503;
  message: string;
}

/** Each S6 error code, its status and its plain message (D47's one error format adds a reference ID). */
export const CHAT_ERRORS = Object.freeze({
  /** Gemma or bge-m3 can't be reached. */
  assistant_unavailable: { status: 503, message: CHAT_TEXT.unavailable },
  /** A body that doesn't fit (S1's code). */
  validation_failed: { status: 400, message: 'The input is not valid.' },
  /** Another person's conversation, another org's, or a missing one. */
  not_found: { status: 404, message: 'The conversation was not found.' },
  /** More than 10 questions and searches in a minute (D64); the API adds "try again in N s". */
  rate_limited: { status: 429, message: 'Too many questions, try again in a minute.' },
} as const satisfies Record<string, ChatError>);

export type ChatErrorCode = keyof typeof CHAT_ERRORS;

export const CHAT_ERROR_CODES = Object.freeze(Object.keys(CHAT_ERRORS) as ChatErrorCode[]);

export function isChatErrorCode(v: unknown): v is ChatErrorCode {
  return typeof v === 'string' && Object.hasOwn(CHAT_ERRORS, v);
}
