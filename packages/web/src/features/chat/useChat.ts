// The chat panel's data (S6-007, D27 #9), around the generated typed client (D30): the person's own
// conversations, latest activity first and paged (GET /api/v1/chat/conversations), one conversation
// with its messages (GET /api/v1/chat/conversations/:id) and starting one (POST
// /api/v1/chat/conversations). Asking streams, so it has its own reader (./stream.ts). The API
// decides what each person sees, down to each citation and each message's label (D7, D50, D51);
// these hooks fetch and cache.
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { api, type GetChatConversationsIdResponse, type GetChatConversationsResponse } from '@/api/client';

export type ConversationRow = GetChatConversationsResponse['items'][number];
export type Conversation = GetChatConversationsIdResponse;
export type Message = Conversation['messages'][number];
export type VisibleMessage = Extract<Message, { hidden: false }>;
export type HiddenMessage = Extract<Message, { hidden: true }>;
export type MessageCitation = VisibleMessage['citations'][number];
export type RecordCitation = Extract<MessageCitation, { type: 'record' }>;
export type PassageCitation = Extract<MessageCitation, { type: 'passage' }>;

export const chatKeys = {
  all: ['chat'] as const,
  list: ['chat', 'conversations'] as const,
  one: (id: string) => ['chat', 'conversation', id] as const,
};

/** How many conversations each "Load more" adds. */
export const CONVERSATION_PAGE_SIZE = 20;

/** The person's own conversations, a page at a time, latest activity first. */
export function useConversationList(enabled: boolean) {
  return useInfiniteQuery({
    queryKey: chatKeys.list,
    queryFn: ({ pageParam }) => api.getChatConversations({ page: pageParam, pageSize: CONVERSATION_PAGE_SIZE }),
    initialPageParam: 1,
    getNextPageParam: (last) => (last.page * last.pageSize < last.total ? last.page + 1 : undefined),
    enabled,
  });
}

/** Reads one conversation with its messages, oldest first. */
export function fetchConversation(id: string): Promise<Conversation> {
  return api.getChatConversationsId({ id });
}

/** One of the person's conversations, while it is open. */
export function useConversation(id: string | null) {
  return useQuery({
    queryKey: chatKeys.one(id ?? 'none'),
    queryFn: () => fetchConversation(id ?? ''),
    enabled: id !== null,
  });
}

/** A message's graph query, when Gemma wrote one. */
export function graphQueryOf(message: VisibleMessage): string | null {
  return typeof message.graphQuery === 'string' && message.graphQuery !== '' ? message.graphQuery : null;
}
