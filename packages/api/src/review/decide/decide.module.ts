// Review part 2, deciding (S5-003): POST /api/v1/review/findings/:id/approve and
// POST /api/v1/review/findings/:id/reject, for the Review-queue `work` cell (the Analyst), with
// S5-001's bodies, outcomes and error codes (./decide.controller.ts, ./decide.service.ts; the graph
// side in ./decide-graph.ts). Runs in the API program; the module declares its own imports: the
// audit trail and outbox from AuditModule, S1's record creation from RecordsModule; the database
// and Neo4j are global.
import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module.js';
import { AuditService } from '../../audit/audit.service.js';
import { AuditOutbox } from '../../audit/outbox.js';
import type { Db } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { GRAPH } from '../../graph/graph.module.js';
import type { GraphService } from '../../graph/graph.service.js';
import { RecordsModule } from '../../records/records.module.js';
import { RecordsService } from '../../records/records.service.js';
import { ReviewDecideController } from './decide.controller.js';
import { ReviewDecideService } from './decide.service.js';

export class ReviewDecideModule {}
Module({
  imports: [AuditModule, RecordsModule],
  controllers: [ReviewDecideController],
  providers: [
    {
      provide: ReviewDecideService,
      useFactory: (db: Db, graph: GraphService, outbox: AuditOutbox, audit: AuditService, records: RecordsService) =>
        new ReviewDecideService({ db, graph, outbox, audit, records }),
      inject: [DB, GRAPH, AuditOutbox, AuditService, RecordsService],
    },
  ],
})(ReviewDecideModule);
