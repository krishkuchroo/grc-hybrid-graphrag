// Review part 1, reading the queue (S5-002): GET /api/v1/review/findings, GET
// /api/v1/review/findings/:id and GET /api/v1/review/counts, for the Review-queue `view` cell (Admin
// and Analyst), with S5-001's list query and answer shapes. Runs in the API program; the module
// declares its own imports.
// - The routes: ./queue.controller.ts. The reads: ./queue.service.ts (Postgres, in the reader's own
//   org context) and ./queue-graph.ts (Neo4j, as the reader's own role x clearance account).
// - It also provides and exports `PendingLinks` (./pending-links.ts, D260): the pending link findings
//   that match a chat question, for the chat's "Not reviewed yet" list. No route of its own.
import { Module } from '@nestjs/common';
import type { Db } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { GRAPH } from '../../graph/graph.module.js';
import type { GraphService } from '../../graph/graph.service.js';
import { ReviewQueueController } from './queue.controller.js';
import { PendingLinks } from './pending-links.js';
import { ReviewQueueService } from './queue.service.js';

export class ReviewQueueModule {}
Module({
  controllers: [ReviewQueueController],
  providers: [
    {
      provide: ReviewQueueService,
      useFactory: (db: Db, graph: GraphService) => new ReviewQueueService({ db, graph }),
      inject: [DB, GRAPH],
    },
    {
      provide: PendingLinks,
      useFactory: (db: Db, graph: GraphService) => new PendingLinks({ db, graph }),
      inject: [DB, GRAPH],
    },
  ],
  exports: [ReviewQueueService, PendingLinks],
})(ReviewQueueModule);
