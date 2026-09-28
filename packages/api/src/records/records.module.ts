// Assets, risks, controls, policies and incidents (D66-D69). Provides the RecordsService (S1-003)
// to later tasks' controllers.
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuditOutbox } from '../audit/outbox.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { GRAPH } from '../graph/graph.module.js';
import type { GraphService } from '../graph/graph.service.js';
import { RecordsService } from './records.service.js';

export class RecordsModule {}
Module({
  imports: [AuditModule],
  providers: [
    {
      provide: RecordsService,
      useFactory: (graph: GraphService, outbox: AuditOutbox, db: Db) => new RecordsService({ graph, outbox, db }),
      inject: [GRAPH, AuditOutbox, DB],
    },
  ],
  exports: [RecordsService],
})(RecordsModule);
