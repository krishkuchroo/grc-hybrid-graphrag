// Assets, risks, controls, policies and incidents (D66-D69). The RecordsService (S1-003), the
// record routes under /api/v1 (S1-004), one controller per kind, and the links routes (S1-005).
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuditOutbox } from '../audit/outbox.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { GRAPH } from '../graph/graph.module.js';
import type { GraphService } from '../graph/graph.service.js';
import { AssetMapController, LinksController, RECORD_LINKS_CONTROLLERS } from './links.controller.js';
import { LinksService } from './links.service.js';
import { RECORDS_CONTROLLERS } from './records.controller.js';
import { RecordsService } from './records.service.js';

export class RecordsModule {}
Module({
  imports: [AuditModule],
  controllers: [...RECORDS_CONTROLLERS, LinksController, ...RECORD_LINKS_CONTROLLERS, AssetMapController],
  providers: [
    {
      provide: RecordsService,
      useFactory: (graph: GraphService, outbox: AuditOutbox, db: Db) => new RecordsService({ graph, outbox, db }),
      inject: [GRAPH, AuditOutbox, DB],
    },
    {
      provide: LinksService,
      useFactory: (graph: GraphService, outbox: AuditOutbox) => new LinksService({ graph, outbox }),
      inject: [GRAPH, AuditOutbox],
    },
  ],
  exports: [RecordsService, LinksService],
})(RecordsModule);
