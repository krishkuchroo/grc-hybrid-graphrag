// Review part 3, removing what turned out false (S5-004): POST /api/v1/review/findings/:id/remove,
// GET /api/v1/review/documents/:id (a document's impact, Review-queue `view`) and
// POST /api/v1/review/documents/:id/remove (one bad upload in a single action, D52.5), the removals
// for the Review-queue `work` cell (the Analyst). Runs in the API program; the module declares its
// own imports.
// - The routes: ./remove.controller.ts.
// - The checks, the order of the two databases and the steps: ./remove.service.ts.
// - The graph reads and writes: ./remove-graph.ts.
import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditOutbox } from '../../audit/outbox.js';
import type { Db } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { GRAPH } from '../../graph/graph.module.js';
import type { GraphService } from '../../graph/graph.service.js';
import { ReviewRemoveController } from './remove.controller.js';
import { ReviewRemoveService } from './remove.service.js';

export class ReviewRemoveModule {}
Module({
  imports: [AuditModule],
  controllers: [ReviewRemoveController],
  providers: [
    {
      provide: ReviewRemoveService,
      useFactory: (db: Db, graph: GraphService, outbox: AuditOutbox, audit: AuditService) =>
        new ReviewRemoveService({ db, graph, outbox, audit }),
      inject: [DB, GRAPH, AuditOutbox, AuditService],
    },
  ],
})(ReviewRemoveModule);
