// Uploads, import mappings and the push API (D40, D44), and the records that first arrive with
// uploads (D202). Audit findings (S3-010): the FindingsService and its routes under
// /api/v1/audit-findings, /api/v1/controls/:id/audit-findings and /api/v1/risks/:id/audit-findings.
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuditOutbox } from '../audit/outbox.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { GRAPH } from '../graph/graph.module.js';
import type { GraphService } from '../graph/graph.service.js';
import {
  AuditFindingsController,
  ControlAuditFindingsController,
  RiskAuditFindingsController,
} from './audit-findings/findings.controller.js';
import { FindingsService } from './audit-findings/findings.service.js';

export class IntakeModule {}
Module({
  imports: [AuditModule],
  controllers: [AuditFindingsController, ControlAuditFindingsController, RiskAuditFindingsController],
  providers: [
    {
      provide: FindingsService,
      useFactory: (graph: GraphService, outbox: AuditOutbox, db: Db) => new FindingsService({ graph, outbox, db }),
      inject: [GRAPH, AuditOutbox, DB],
    },
  ],
  exports: [FindingsService],
})(IntakeModule);
