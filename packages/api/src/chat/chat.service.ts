// Conversations and their messages (S6-006 behaviour 1 and 2.7; D47, D51, D56, D73; S6 shared notes,
// "Messages and labels" and "Audit").
// - A conversation is its owner's only: the asker's principal user ID (an API key's is its own), in
//   one org. Every read and write runs in the caller's own org context (`withOrgContext`), so
//   Postgres row security checks the org and the owner, and each query names them again. Another
//   person's conversation, another org's, a malformed ID or a missing one is 404 `not_found`.
// - The list is paged, latest activity first. Starting one gives "New conversation" until its first
//   question names it.
// - Reading one gives its messages oldest first. A message whose label is above the reader's current
//   clearance shows its question only (`hidden: true`, S6-Q9). Each citation of the others is read
//   again with the reader's access now (./citation-reader.ts); one they can't see any more is
//   "a source you can no longer see".
// - Saving a message is one transaction: the conversation is locked, the message inserted, the
//   title (on the first question) and the last activity set, and the `chat.asked` entry appended
//   (`AuditService.appendInTx`) with the message as its target, the question's words in `after`, and
//   the mode, the graph path, the cited records and documents and the label in `meta` (D186).
// - Logs hold IDs and codes only, never a question, an answer or a title (D163).
import {
  CHAT_AUDIT_ACTIONS,
  CHAT_ERRORS,
  CHAT_MESSAGE_STATUSES,
  CHAT_MESSAGE_TARGET_TYPE,
  CHAT_TEXT,
  DEFAULT_SEARCH_MODE,
  GRAPH_FALLBACK_REASONS,
  LABELS,
  SEARCH_MODES,
  askBodySchema,
  chatConversationRowSchema,
  conversationTitle,
  isVisible,
  startConversationBodySchema,
  type ChatAskedMeta,
  type ChatConversation,
  type ChatConversationRow,
  type ChatMessage,
  type ChatMessageStatus,
  type ChatMessageTimings,
  type ChatPromptVersions,
  type Citation,
  type GraphFallbackReason,
  type Label,
  type SearchMode,
  type StoredCitation,
  type VisibleChatMessage,
} from '@grc/shared';
import { and, asc, count, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { AuditService } from '../audit/audit.service.js';
import { ApiError } from '../common/errors.js';
import { pageQuerySchema, type Paged } from '../common/paging.js';
import type { Db } from '../db/client.js';
import { withOrgContext, type OrgContext } from '../db/org-context.js';
import type { Caller } from '../records/records.service.js';
import type { CitationReader, CitedSourcesNow } from './citation-reader.js';
import { chatConversations, chatMessages, type ChatConversationDbRow, type ChatMessageDbRow } from './chat.schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `GET /api/v1/chat/conversations`'s query: the page only. Anything else is refused (400). */
export const conversationListQuerySchema = z.strictObject({
  page: pageQuerySchema.shape.page,
  pageSize: pageQuerySchema.shape.pageSize,
});

export const pagedConversationsSchema = z.object({
  items: z.array(chatConversationRowSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int(),
});

// A conversation's message count, as a list column. Written with explicit table names: in a
// one-table select Drizzle leaves column names unqualified, which inside a subquery would name the
// subquery's own table. Row security on chat_messages applies to it too.
const MESSAGE_COUNT =
  sql<number>`(SELECT count(*) FROM "chat_messages" AS "m" WHERE "m"."org_id" = "chat_conversations"."org_id" AND "m"."owner_id" = "chat_conversations"."owner_id" AND "m"."conversation_id" = "chat_conversations"."id")`.mapWith(
    Number,
  );

const NOT_FOUND = (): ApiError => new ApiError(404, 'not_found', CHAT_ERRORS.not_found.message);

function contextOf(caller: Caller): OrgContext {
  return { orgId: caller.orgId, userId: caller.userId, role: caller.role, clearance: caller.clearance };
}

function actorOf(caller: Caller): { actorType: 'user' | 'api_key'; actorId: string } {
  return caller.apiKeyId !== undefined
    ? { actorType: 'api_key', actorId: caller.apiKeyId }
    : { actorType: 'user', actorId: caller.userId };
}

function ownConversation(caller: Caller, id: string) {
  return and(
    eq(chatConversations.orgId, caller.orgId),
    eq(chatConversations.ownerId, caller.userId),
    eq(chatConversations.id, id),
  );
}

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function ms(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function promptVersionsOf(value: unknown): ChatPromptVersions {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    graphQuery: typeof v.graphQuery === 'string' ? v.graphQuery : null,
    answer: typeof v.answer === 'string' ? v.answer : null,
  };
}

function timingsOf(value: unknown): ChatMessageTimings {
  const v = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  return {
    waitedMs: ms(v.waitedMs) ?? 0,
    searchingMs: ms(v.searchingMs),
    firstWordsMs: ms(v.firstWordsMs),
    totalMs: ms(v.totalMs) ?? 0,
  };
}

function isStatus(value: unknown): value is ChatMessageStatus {
  return typeof value === 'string' && (CHAT_MESSAGE_STATUSES as readonly string[]).includes(value);
}

function isMode(value: unknown): value is SearchMode {
  return typeof value === 'string' && (SEARCH_MODES as readonly string[]).includes(value);
}

function isFallback(value: unknown): value is GraphFallbackReason {
  return typeof value === 'string' && (GRAPH_FALLBACK_REASONS as readonly string[]).includes(value);
}

function isLabel(value: unknown): value is Label {
  return typeof value === 'string' && (LABELS as readonly string[]).includes(value);
}

/** A saved message, shown with the citations given. */
export function visibleMessage(row: ChatMessageDbRow, citations: Citation[]): VisibleChatMessage {
  return {
    id: row.id,
    question: row.question,
    answer: row.answer,
    status: isStatus(row.status) ? row.status : 'failed',
    mode: isMode(row.mode) ? row.mode : DEFAULT_SEARCH_MODE,
    fallback: isFallback(row.fallbackReason) ? row.fallbackReason : null,
    citations,
    graphQuery: row.graphQuery,
    model: row.model,
    promptVersions: promptVersionsOf(row.promptVersions),
    timings: timingsOf(row.timings),
    label: isLabel(row.label) ? row.label : 'restricted',
    createdAt: iso(row.createdAt),
    hidden: false,
  };
}

/** A saved message as the reader may see it now. */
function messageFor(reader: Caller, row: ChatMessageDbRow, now: CitedSourcesNow): ChatMessage {
  // An unknown label counts as above everyone's clearance (fail safe).
  if (!isLabel(row.label) || !isVisible(reader.clearance, row.label)) {
    return { id: row.id, question: row.question, createdAt: iso(row.createdAt), hidden: true };
  }
  const stored: StoredCitation[] = Array.isArray(row.citations) ? row.citations : [];
  const citations: Citation[] = stored.map((c): Citation => {
    if (c.type === 'record') {
      const record = now.record(c.recordKind, c.recordId);
      return record ? { number: c.number, type: 'record', record } : { number: c.number, type: 'hidden' };
    }
    const passage = now.passage(c.chunkId, c.documentId);
    return passage ? { number: c.number, type: 'passage', passage } : { number: c.number, type: 'hidden' };
  });
  return visibleMessage(row, citations);
}

function conversationOut(row: ChatConversationDbRow, messages: ChatMessage[]): ChatConversation {
  return {
    id: row.id,
    title: row.title,
    createdAt: iso(row.createdAt),
    lastActivityAt: iso(row.updatedAt),
    messages,
  };
}

/** What asking needs once the body and the conversation have been checked. */
export interface AskInput {
  caller: Caller;
  conversationId: string;
  /** Trimmed, 1 to 2,000 characters. Never logged. */
  question: string;
  mode: SearchMode;
}

/** One message to save, with what its `chat.asked` entry needs besides it. */
export interface MessageToSave {
  question: string;
  answer: string;
  status: ChatMessageStatus;
  mode: SearchMode;
  fallbackReason: GraphFallbackReason | null;
  citations: StoredCitation[];
  graphQuery: string | null;
  model: string | null;
  promptVersions: ChatPromptVersions;
  timings: ChatMessageTimings;
  label: Label;
  /** When the question was asked: the message's created time. */
  askedAt: Date;
  /** Whether the graph query ran (hybrid only). */
  graphRan: boolean;
}

export interface ChatServiceDeps {
  db: Db;
  audit: Pick<AuditService, 'appendInTx'>;
  citations: Pick<CitationReader, 'read'>;
}

export class ChatService {
  private readonly db: Db;
  private readonly audit: Pick<AuditService, 'appendInTx'>;
  private readonly citations: Pick<CitationReader, 'read'>;

  constructor(deps: ChatServiceDeps) {
    this.db = deps.db;
    this.audit = deps.audit;
    this.citations = deps.citations;
  }

  /** The caller's own conversations, latest activity first. */
  async list(caller: Caller, query: unknown): Promise<Paged<ChatConversationRow>> {
    const q = conversationListQuerySchema.parse(query ?? {});
    const where = and(eq(chatConversations.orgId, caller.orgId), eq(chatConversations.ownerId, caller.userId));
    return withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [counted] = await tx.select({ total: count() }).from(chatConversations).where(where);
      const rows = await tx
        .select({
          id: chatConversations.id,
          title: chatConversations.title,
          createdAt: chatConversations.createdAt,
          updatedAt: chatConversations.updatedAt,
          messageCount: MESSAGE_COUNT,
        })
        .from(chatConversations)
        .where(where)
        .orderBy(desc(chatConversations.updatedAt), desc(chatConversations.id))
        .limit(q.pageSize)
        .offset((q.page - 1) * q.pageSize);
      return {
        items: rows.map((r) => ({
          id: r.id,
          title: r.title,
          createdAt: iso(r.createdAt),
          lastActivityAt: iso(r.updatedAt),
          messageCount: Number.isFinite(r.messageCount) ? r.messageCount : 0,
        })),
        page: q.page,
        pageSize: q.pageSize,
        total: Number(counted?.total ?? 0),
      };
    });
  }

  /** Starts an empty conversation, titled "New conversation" until its first question. */
  async start(caller: Caller, body: unknown): Promise<ChatConversation> {
    startConversationBodySchema.parse(body ?? {});
    const row = await withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [inserted] = await tx
        .insert(chatConversations)
        .values({ orgId: caller.orgId, ownerId: caller.userId, title: CHAT_TEXT.newConversation })
        .returning();
      return inserted;
    });
    if (!row) throw new Error('chat: the new conversation was not returned');
    return conversationOut(row, []);
  }

  /** One of the caller's own conversations, with its messages oldest first. */
  async get(caller: Caller, id: string): Promise<ChatConversation> {
    if (typeof id !== 'string' || !UUID.test(id)) throw NOT_FOUND();
    const found = await withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [conversation] = await tx.select().from(chatConversations).where(ownConversation(caller, id)).limit(1);
      if (!conversation) return undefined;
      const messages = await tx
        .select()
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.orgId, caller.orgId),
            eq(chatMessages.ownerId, caller.userId),
            eq(chatMessages.conversationId, id),
          ),
        )
        .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id));
      return { conversation, messages };
    });
    if (!found) throw NOT_FOUND();

    // Only the citations of messages the reader may see are read again.
    const shown = found.messages.filter((m) => isLabel(m.label) && isVisible(caller.clearance, m.label));
    const now = await this.citations.read(
      caller,
      shown.flatMap((m) => (Array.isArray(m.citations) ? m.citations : [])),
    );
    return conversationOut(
      found.conversation,
      found.messages.map((m) => messageFor(caller, m, now)),
    );
  }

  /** Checks an ask's body (400) and that the conversation is the caller's own (404), before any of
   * the answer is streamed. */
  async prepareAsk(caller: Caller, id: string, body: unknown): Promise<AskInput> {
    const input = askBodySchema.parse(body);
    if (typeof id !== 'string' || !UUID.test(id)) throw NOT_FOUND();
    const exists = await withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [row] = await tx
        .select({ id: chatConversations.id })
        .from(chatConversations)
        .where(ownConversation(caller, id))
        .limit(1);
      return row !== undefined;
    });
    if (!exists) throw NOT_FOUND();
    return { caller, conversationId: id, question: input.question, mode: input.mode ?? DEFAULT_SEARCH_MODE };
  }

  /** Saves one message, sets the conversation's title and last activity, and writes its `chat.asked`
   * entry, all in one transaction. */
  async saveMessage(caller: Caller, conversationId: string, message: MessageToSave): Promise<ChatMessageDbRow> {
    return withOrgContext(this.db, contextOf(caller), async (tx) => {
      const [conversation] = await tx
        .select({ id: chatConversations.id })
        .from(chatConversations)
        .where(ownConversation(caller, conversationId))
        .for('update');
      if (!conversation) throw NOT_FOUND();

      const [before] = await tx
        .select({ n: count() })
        .from(chatMessages)
        .where(
          and(
            eq(chatMessages.orgId, caller.orgId),
            eq(chatMessages.ownerId, caller.userId),
            eq(chatMessages.conversationId, conversationId),
          ),
        );
      const first = Number(before?.n ?? 0) === 0;

      const [row] = await tx
        .insert(chatMessages)
        .values({
          orgId: caller.orgId,
          conversationId,
          ownerId: caller.userId,
          question: message.question,
          answer: message.answer,
          status: message.status,
          mode: message.mode,
          fallbackReason: message.mode === 'hybrid' ? message.fallbackReason : null,
          citations: message.citations,
          graphQuery: message.mode === 'hybrid' ? message.graphQuery : null,
          model: message.model,
          promptVersions: message.promptVersions,
          timings: message.timings,
          label: message.label,
          createdAt: message.askedAt,
        })
        .returning();
      if (!row) throw new Error('chat: the saved message was not returned');

      await tx
        .update(chatConversations)
        .set(first ? { title: conversationTitle(message.question), updatedAt: sql`now()` } : { updatedAt: sql`now()` })
        .where(ownConversation(caller, conversationId));

      const citedRecords: ChatAskedMeta['citedRecords'] = [];
      const citedDocuments: string[] = [];
      for (const c of message.citations) {
        if (c.type === 'record') {
          if (!citedRecords.some((r) => r.id === c.recordId))
            citedRecords.push({ id: c.recordId, number: c.recordNumber });
        } else if (!citedDocuments.includes(c.documentId)) {
          citedDocuments.push(c.documentId);
        }
      }
      const meta: ChatAskedMeta = {
        mode: message.mode,
        graphRan: message.mode === 'hybrid' && message.graphRan,
        fallback: message.mode === 'hybrid' ? message.fallbackReason : null,
        citedRecords,
        citedDocuments,
        label: message.label,
      };
      await this.audit.appendInTx(tx, {
        orgId: caller.orgId,
        ...actorOf(caller),
        action: CHAT_AUDIT_ACTIONS.asked,
        targetType: CHAT_MESSAGE_TARGET_TYPE,
        targetId: row.id,
        after: { question: message.question },
        meta,
      });
      return row;
    });
  }
}
