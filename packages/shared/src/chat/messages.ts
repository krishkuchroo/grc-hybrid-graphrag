// Conversations and messages (D47, D51, D73; S6 shared notes, "Messages and labels"), shared by the
// chat routes (S6-006), the panel (S6-007) and the benchmark (S8). A conversation is its owner's
// only: the asker's principal user ID (an API key's is its own), in one org.
// - A list row: ID, title, created, last activity and message count. A detail: the same, with its
//   messages, oldest first.
// - A message: the question, the answer, its status (`answered`, `stopped` or `failed`), mode,
//   fallback reason, citations, graph query, model, prompt versions, timings, label and created
//   time. Each citation is read again with the reader's access now: a source, or `{ type: 'hidden' }`
//   for one they can't see any more. A message whose label is above the reader's current clearance
//   is `{ hidden: true }` with its question only (S6-Q9).
// - What is stored for a citation is only what's needed to read it again: the record's ID, number
//   and kind, or the passage's chunk and document IDs.
// Times are in milliseconds.
import { z } from 'zod';
import { LABELS } from '../access/labels.js';
import { searchRecordNumberSchema } from '../search/answers.js';
import { searchModeSchema } from '../search/bodies.js';
import { GRAPH_FALLBACK_REASONS } from '../search/fallback.js';
import { SEARCH_RECORD_KINDS } from '../search/kinds.js';
import { SEARCH_LIMITS } from '../search/limits.js';
import { passageSourceSchema, recordSourceSchema, sourceNumberSchema } from '../search/sources.js';
import { chatPendingLinksSchema } from './pending-links.js';
import { CHAT_TEXT } from './words.js';

const dateTime = z.iso.datetime({ offset: true });
const ms = z.number().min(0);

/** `answered`; `stopped` (the person stopped it, or its time or length limit cut it, with what was
 * written); `failed` (Gemma or bge-m3 couldn't be reached). */
export const CHAT_MESSAGE_STATUSES = ['answered', 'stopped', 'failed'] as const;
export type ChatMessageStatus = (typeof CHAT_MESSAGE_STATUSES)[number];

export function isChatMessageStatus(v: unknown): v is ChatMessageStatus {
  return typeof v === 'string' && (CHAT_MESSAGE_STATUSES as readonly string[]).includes(v);
}

/** A cited source the reader can't see any more. */
export const hiddenCitationSchema = z.object({ number: sourceNumberSchema, type: z.literal('hidden') });

/** A citation: a source number with its source, or one the reader can no longer see. */
export const citationSchema = z.discriminatedUnion('type', [
  recordSourceSchema,
  passageSourceSchema,
  hiddenCitationSchema,
]);

/** A citation as stored with its message (`chat_messages.citations`). */
export const storedCitationSchema = z.discriminatedUnion('type', [
  z.object({
    number: sourceNumberSchema,
    type: z.literal('record'),
    recordId: z.uuid(),
    recordNumber: searchRecordNumberSchema,
    recordKind: z.enum(SEARCH_RECORD_KINDS),
  }),
  z.object({
    number: sourceNumberSchema,
    type: z.literal('passage'),
    chunkId: z.uuid(),
    documentId: z.uuid(),
  }),
]);

/** The prompt versions a message used (D45.8, D69): null for a step that didn't run. */
export const chatPromptVersionsSchema = z.object({
  graphQuery: z.string().nullable(),
  answer: z.string().nullable(),
});

export const chatMessageTimingsSchema = z.object({
  /** Waiting for Gemma's turn. */
  waitedMs: ms,
  /** Finding the sources (both paths and fusion); null when it didn't get that far. */
  searchingMs: ms.nullable(),
  /** From the question to the first words of the answer; null when none were written. */
  firstWordsMs: ms.nullable(),
  /** From the question to the end. */
  totalMs: ms,
});

export const visibleChatMessageSchema = z.object({
  id: z.uuid(),
  question: z.string(),
  /** What was written; empty for a failed message. */
  answer: z.string(),
  status: z.enum(CHAT_MESSAGE_STATUSES),
  mode: searchModeSchema,
  fallback: z.enum(GRAPH_FALLBACK_REASONS).nullable(),
  citations: z.array(citationSchema),
  graphQuery: z.string().nullable(),
  model: z.string().nullable(),
  promptVersions: chatPromptVersionsSchema,
  timings: chatMessageTimingsSchema,
  label: z.enum(LABELS),
  createdAt: dateTime,
  /** The pending link findings that matched the question (D260), read again with the reader's
   * access now; null for a role that can't open the review queue, or when none were looked up. */
  pendingLinks: chatPendingLinksSchema.nullable(),
  hidden: z.literal(false),
});

/** A message above the reader's current clearance: its question only. */
export const hiddenChatMessageSchema = z.object({
  id: z.uuid(),
  question: z.string(),
  createdAt: dateTime,
  hidden: z.literal(true),
});

export const chatMessageSchema = z.discriminatedUnion('hidden', [visibleChatMessageSchema, hiddenChatMessageSchema]);

const conversationBase = {
  id: z.uuid(),
  title: z.string(),
  createdAt: dateTime,
  lastActivityAt: dateTime,
};

/** A row of `GET /api/v1/chat/conversations`, latest activity first. */
export const chatConversationRowSchema = z.object({ ...conversationBase, messageCount: z.int().min(0) });

/** `GET /api/v1/chat/conversations/:id`: the conversation with its messages, oldest first. */
export const chatConversationSchema = z.object({ ...conversationBase, messages: z.array(chatMessageSchema) });

export type HiddenCitation = z.infer<typeof hiddenCitationSchema>;
export type Citation = z.infer<typeof citationSchema>;
export type StoredCitation = z.infer<typeof storedCitationSchema>;
export type ChatPromptVersions = z.infer<typeof chatPromptVersionsSchema>;
export type ChatMessageTimings = z.infer<typeof chatMessageTimingsSchema>;
export type VisibleChatMessage = z.infer<typeof visibleChatMessageSchema>;
export type HiddenChatMessage = z.infer<typeof hiddenChatMessageSchema>;
export type ChatMessage = z.infer<typeof chatMessageSchema>;
export type ChatConversationRow = z.infer<typeof chatConversationRowSchema>;
export type ChatConversation = z.infer<typeof chatConversationSchema>;

/** A conversation's title from its first question: its first 80 characters (whole characters, not
 * halves of one), trimmed; "New conversation" when there is nothing left. */
export function conversationTitle(question: string): string {
  const chars = Array.from(typeof question === 'string' ? question.trim() : '');
  const title = chars.slice(0, SEARCH_LIMITS.conversationTitleLength).join('').trim();
  return title === '' ? CHAT_TEXT.newConversation : title;
}
