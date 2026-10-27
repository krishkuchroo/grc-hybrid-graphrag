// Chat (S6-006; D3 (b), D45.7, D47, D48, D56, D64): a person asks a question and gets Gemma's answer
// streamed as it's written, with citations, queued fairly, saved in their own conversation and
// audited. Runs in the API program; the worker builds it but serves no routes.
// - The routes: ./chat.controller.ts. Conversations and the save transaction: ./chat.service.ts.
//   Citations read again with the reader's access now: ./citation-reader.ts. One question, step by
//   step: ./ask.ts, with the answer prompt (./answer-prompt.ts) and the citations (./citations.ts).
//   The event stream: ./event-stream.ts. The 10-a-minute limit: ./chat-rate-limit.ts, registered in
//   main.api.ts. The tables: ./chat.schema.ts. The real-Gemma try command: ./try.ts.
// - Retrieval comes only through `RETRIEVAL` (SearchModule), Gemma through `TEXT_MODEL` (AiModule),
//   and the "Not reviewed yet" list through `PendingLinks` (ReviewQueueModule, D260).
import { Module } from '@nestjs/common';
import { AiModule } from '../ai/ai.module.js';
import { TEXT_MODEL, type TextModel } from '../ai/text-model.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuditService } from '../audit/audit.service.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { GRAPH } from '../graph/graph.module.js';
import type { GraphService } from '../graph/graph.service.js';
import { PendingLinks } from '../review/queue/pending-links.js';
import { ReviewQueueModule } from '../review/queue/queue.module.js';
import { RETRIEVAL, type Retrieval } from '../search/retrieval.js';
import { SearchModule } from '../search/search.module.js';
import { AskRunner } from './ask.js';
import { ChatController } from './chat.controller.js';
import { ChatService } from './chat.service.js';
import { CitationReader } from './citation-reader.js';

export class ChatModule {}
Module({
  imports: [SearchModule, AiModule, AuditModule, ReviewQueueModule],
  controllers: [ChatController],
  providers: [
    {
      provide: CitationReader,
      useFactory: (db: Db, graph: GraphService) => new CitationReader({ db, graph }),
      inject: [DB, GRAPH],
    },
    {
      provide: ChatService,
      useFactory: (db: Db, audit: AuditService, citations: CitationReader, pendingLinks: PendingLinks) =>
        new ChatService({ db, audit, citations, pendingLinks }),
      inject: [DB, AuditService, CitationReader, PendingLinks],
    },
    {
      provide: AskRunner,
      useFactory: (textModel: TextModel, retrieval: Retrieval, chat: ChatService, pendingLinks: PendingLinks) =>
        new AskRunner({ textModel, retrieval, chat, pendingLinks }),
      inject: [TEXT_MODEL, RETRIEVAL, ChatService, PendingLinks],
    },
  ],
})(ChatModule);
