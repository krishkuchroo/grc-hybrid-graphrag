// The chat tables in Postgres (S6-001; D47, D51, D56, D73), created by the chat migration. Both are
// org tables (M0-009 rule: `org_id uuid not null`, RLS enabled and forced) whose row security is
// narrower than the standard org wall: every read, insert and update needs the row's org to be the
// context org (`app.org_id`) and its owner to be the asker (`app.user_id`), so a conversation and
// its messages are their owner's only (D73).
//
// - `chat_conversations`: one per conversation. `ownerId` is the asker's principal user ID (an API
//   key's is `api_key:<id>`). grc_app may insert, and change only `title` and `updatedAt` (the last
//   activity); never delete.
// - `chat_messages`: one per question, with its answer, status, mode, fallback reason, citations
//   (S6-001's stored citation shape), graph query, model, prompt versions, timings and label (the
//   highest label among the sources given to Gemma, Public when none). The foreign key covers
//   (org, owner, conversation), so a message can only go into its owner's own conversation in the
//   same org. grc_app may insert and read; never change or delete.
import {
  CHAT_MESSAGE_STATUSES,
  GRAPH_FALLBACK_REASONS,
  LABELS,
  SEARCH_LIMITS,
  SEARCH_MODES,
  type ChatMessageStatus,
  type ChatMessageTimings,
  type ChatPromptVersions,
  type GraphFallbackReason,
  type Label,
  type SearchMode,
  type StoredCitation,
} from '@grc/shared';
import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { organization } from '../identity/schema.js';

/** An owner ID is 1 to 200 characters. */
export const MAX_CHAT_OWNER_ID_LENGTH = 200;

// `<column> IN ('a', 'b', …)` from a fixed list of lowercase names.
function inList(column: AnyPgColumn, values: readonly string[]): SQL {
  for (const v of values) {
    if (!/^[a-z_]+$/.test(v)) throw new Error(`chat.schema: unexpected list value '${v}'`);
  }
  return sql`${column} IN (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;
}

function between(column: AnyPgColumn, min: number, max: number): SQL {
  return sql`char_length(${column}) BETWEEN ${sql.raw(String(min))} AND ${sql.raw(String(max))}`;
}

export const chatConversations = pgTable(
  'chat_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    /** The asker's principal user ID; only they see the conversation. */
    ownerId: text('owner_id').notNull(),
    /** "New conversation", then the first 80 characters of its first question. Never logged. */
    title: text('title').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** The last activity: set again with every question. */
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The target of the messages' foreign key, so a message's org and owner are its conversation's.
    unique('chat_conversations_org_owner_id_unique').on(t.orgId, t.ownerId, t.id),
    index('chat_conversations_org_owner_updated_idx').on(t.orgId, t.ownerId, t.updatedAt, t.id),
    check('chat_conversations_owner_check', between(t.ownerId, 1, MAX_CHAT_OWNER_ID_LENGTH)),
    check('chat_conversations_title_check', between(t.title, 1, SEARCH_LIMITS.conversationTitleLength)),
  ],
);

export const chatMessages = pgTable(
  'chat_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    orgId: uuid('org_id')
      .notNull()
      .references(() => organization.id),
    conversationId: uuid('conversation_id').notNull(),
    /** The conversation's owner, the asker. */
    ownerId: text('owner_id').notNull(),
    /** The asker's words. Never logged (D163). */
    question: text('question').notNull(),
    /** What was written; empty for a failed message. Never logged (D163). */
    answer: text('answer').notNull().default(''),
    status: text('status').$type<ChatMessageStatus>().notNull(),
    mode: text('mode').$type<SearchMode>().notNull(),
    /** Why the graph path fell back (hybrid only); null when it didn't. */
    fallbackReason: text('fallback_reason').$type<GraphFallbackReason>(),
    /** The sources the answer cited, as S6-001's stored citations. */
    citations: jsonb('citations')
      .$type<StoredCitation[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /** The graph query Gemma wrote (hybrid only); null when none. Never logged (D163). */
    graphQuery: text('graph_query'),
    /** The model that answered; null when Gemma wasn't asked. */
    model: text('model'),
    promptVersions: jsonb('prompt_versions')
      .$type<ChatPromptVersions>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    timings: jsonb('timings')
      .$type<ChatMessageTimings>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** The highest label among the sources given to Gemma; Public when none (D51, S6-Q9). */
    label: text('label').$type<Label>().notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // The conversation must be the same org's and the same owner's (a foreign key check doesn't
    // pass through RLS).
    foreignKey({
      name: 'chat_messages_conversation_fk',
      columns: [t.orgId, t.ownerId, t.conversationId],
      foreignColumns: [chatConversations.orgId, chatConversations.ownerId, chatConversations.id],
    }),
    index('chat_messages_org_conversation_created_idx').on(t.orgId, t.conversationId, t.createdAt, t.id),
    check('chat_messages_question_check', between(t.question, 1, SEARCH_LIMITS.questionMaxLength)),
    check('chat_messages_status_check', inList(t.status, CHAT_MESSAGE_STATUSES)),
    check('chat_messages_mode_check', inList(t.mode, SEARCH_MODES)),
    check(
      'chat_messages_fallback_reason_check',
      sql`${t.fallbackReason} IS NULL OR (${t.mode} = 'hybrid' AND ${inList(t.fallbackReason, GRAPH_FALLBACK_REASONS)})`,
    ),
    check('chat_messages_citations_check', sql`jsonb_typeof(${t.citations}) = 'array'`),
    check(
      'chat_messages_graph_query_check',
      sql`${t.graphQuery} IS NULL OR (${t.mode} = 'hybrid' AND ${between(t.graphQuery, 1, SEARCH_LIMITS.graphQueryMaxLength)})`,
    ),
    check('chat_messages_prompt_versions_check', sql`jsonb_typeof(${t.promptVersions}) = 'object'`),
    check('chat_messages_timings_check', sql`jsonb_typeof(${t.timings}) = 'object'`),
    check('chat_messages_label_check', inList(t.label, LABELS)),
  ],
);

export type ChatConversationDbRow = typeof chatConversations.$inferSelect;
export type NewChatConversationDbRow = typeof chatConversations.$inferInsert;
export type ChatMessageDbRow = typeof chatMessages.$inferSelect;
export type NewChatMessageDbRow = typeof chatMessages.$inferInsert;
