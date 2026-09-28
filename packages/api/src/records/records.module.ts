// Assets, risks, controls, policies and incidents (D66-D69). The RecordsService (S1-003) and the
// record routes under /api/v1 (S1-004), one controller per kind.
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuditOutbox } from '../audit/outbox.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { GRAPH } from '../graph/graph.module.js';
import type { GraphService } from '../graph/graph.service.js';
import { RECORDS_CONTROLLERS } from './records.controller.js';
import { RecordsService } from './records.service.js';

export class RecordsModule {}
Module({
  imports: [AuditModule],
  controllers: RECORDS_CONTROLLERS,
  providers: [
    {
      provide: RecordsService,
      useFactory: (graph: GraphService, outbox: AuditOutbox, db: Db) => new RecordsService({ graph, outbox, db }),
      inject: [GRAPH, AuditOutbox, DB],
    },
  ],
  exports: [RecordsService],
})(RecordsModule);
