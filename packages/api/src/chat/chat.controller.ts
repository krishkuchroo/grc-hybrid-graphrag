// The chat routes (S6-006; D47, D50 Chat row, D51, D64, D73), under /api/v1, all with the Chat cell
// (action `use`: every role, people and API keys alike, S6-Q8):
//   GET  /chat/conversations                the caller's own, paged, latest activity first
//   POST /chat/conversations                start an empty one ("New conversation")       201
//   GET  /chat/conversations/:id            one of the caller's own, with its messages     404 when not theirs
//   POST /chat/conversations/:id/messages   { question, mode? }: ask; the answer streams as
//                                           text/event-stream (queued, step, sources, token, then done
//                                           or error). 400 for a bad body and 404 for a conversation
//                                           that isn't theirs, both before the stream starts. 429 for
//                                           the 11th question or search in a minute (./chat-rate-limit.ts).
// The org, role and clearance always come from `request.principal`.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Body, Controller, Get, Inject, Param, Post, Query, Req, Res, UseGuards } from '@nestjs/common';
import {
  askBodySchema,
  chatConversationSchema,
  chatStreamEventSchema,
  startConversationBodySchema,
  type ChatConversation,
  type ChatConversationRow,
} from '@grc/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { AccessGuard } from '../access/access.guard.js';
import { Requires } from '../access/requires.decorator.js';
import { errorKind } from '../common/errors.js';
import { documentRoute } from '../common/openapi.js';
import type { Paged } from '../common/paging.js';
import type { AuthedRequest } from '../identity/session.guard.js';
import { callerOf } from '../intake/imports/imports.controller.js';
import { AskRunner } from './ask.js';
import { ChatService, conversationListQuerySchema, pagedConversationsSchema } from './chat.service.js';
import { ChatEventStream } from './event-stream.js';

export class ChatController {
  constructor(
    private readonly chat: ChatService,
    private readonly asker: AskRunner,
  ) {}

  list(request: AuthedRequest, query: unknown): Promise<Paged<ChatConversationRow>> {
    return this.chat.list(callerOf(request), query ?? {});
  }

  start(request: AuthedRequest, body: unknown): Promise<ChatConversation> {
    return this.chat.start(callerOf(request), body);
  }

  get(request: AuthedRequest, id: string): Promise<ChatConversation> {
    return this.chat.get(callerOf(request), id);
  }

  async ask(request: FastifyRequest & AuthedRequest, reply: FastifyReply, id: string, body: unknown): Promise<void> {
    const caller = callerOf(request);
    // Refusals before the stream starts leave in the one error format (D47).
    const input = await this.chat.prepareAsk(caller, id, body);

    void reply.hijack();
    const stream = new ChatEventStream(reply.raw);
    try {
      stream.open();
      await this.asker.run(input, stream, stream.left);
    } catch (err) {
      // `run` never rejects; this is the stream itself failing. Nothing can be sent any more.
      request.log.error({ ...errorKind(err), orgId: caller.orgId, conversationId: id }, 'chat stream failed');
    } finally {
      stream.end();
    }
  }
}
{
  const p = ChatController.prototype;
  const d = (method: keyof ChatController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Get()(p, 'list', d('list'));
  Req()(p, 'list', 0);
  Query()(p, 'list', 1);

  Post()(p, 'start', d('start'));
  Req()(p, 'start', 0);
  Body()(p, 'start', 1);

  Get(':id')(p, 'get', d('get'));
  Req()(p, 'get', 0);
  Param('id')(p, 'get', 1);

  Post(':id/messages')(p, 'ask', d('ask'));
  Req()(p, 'ask', 0);
  Res()(p, 'ask', 1);
  Param('id')(p, 'ask', 2);
  Body()(p, 'ask', 3);

  Requires('chat', 'use')(ChatController);
  UseGuards(AccessGuard)(ChatController);
  Controller('chat/conversations')(ChatController);
  Inject(ChatService)(ChatController, undefined, 0);
  Inject(AskRunner)(ChatController, undefined, 1);
}

documentRoute({
  method: 'get',
  path: '/chat/conversations',
  summary: "The caller's own conversations, paged, latest activity first, each with its message count",
  response: pagedConversationsSchema,
  query: conversationListQuerySchema,
});
documentRoute({
  method: 'post',
  path: '/chat/conversations',
  summary: 'Start an empty conversation, titled "New conversation" until its first question names it',
  body: startConversationBodySchema,
  response: chatConversationSchema,
});
documentRoute({
  method: 'get',
  path: '/chat/conversations/{id}',
  summary:
    "One of the caller's own conversations with its messages, oldest first. Each citation is read again with the caller's access now; one they can no longer see is { type: 'hidden' }. A message above their current clearance shows its question only (hidden: true). 404 for anyone else's",
  response: chatConversationSchema,
});
documentRoute({
  method: 'post',
  path: '/chat/conversations/{id}/messages',
  summary:
    'Ask a question (hybrid by default; vector is for the benchmark). Answers text/event-stream, one event per frame (event: <name>, data: <JSON>): queued (the place in the queue, while waiting), step, sources, token (the answer as it is written), then done (the saved message) or error (code, message, referenceId). Every question is saved and audited as chat.asked, answered, stopped or failed. 400 and 404 come before the stream; 429 after 10 questions and searches in a minute',
  body: askBodySchema,
  response: chatStreamEventSchema,
  responseContentType: 'text/event-stream',
});
