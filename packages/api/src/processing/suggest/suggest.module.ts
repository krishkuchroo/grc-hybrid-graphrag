// Processing part 6, mapping suggestions (S4-009): `processing.mapping-suggest` has Gemma suggest
// control-to-requirement and SOC 2 cross-framework links, all for the Analyst (D16(b), D20). Its job
// handlers register in the worker program only, and the module declares its own imports.
// - The route: POST /api/v1/mappings/suggestions (./suggestions.controller.ts), which queues a run
//   and audits `mapping_suggestions.started` (./suggestions.service.ts).
// - The run: ./mapping-suggest.job.ts, registered by the worker program only.
import { Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { TEXT_MODEL, type TextModel } from '../../ai/text-model.js';
import { AuditModule } from '../../audit/audit.module.js';
import { AuditService } from '../../audit/audit.service.js';
import type { Db } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { GRAPH } from '../../graph/graph.module.js';
import type { GraphService } from '../../graph/graph.service.js';
import { JobsService } from '../../jobs/jobs.module.js';
import { MappingSuggestWorker } from './mapping-suggest.job.js';
import { MappingSuggestionsController } from './suggestions.controller.js';
import { MappingSuggestionsService } from './suggestions.service.js';

export class SuggestModule {}
Module({
  imports: [AuditModule, AiModule],
  controllers: [MappingSuggestionsController],
  providers: [
    {
      provide: MappingSuggestionsService,
      useFactory: (db: Db, audit: AuditService, jobs: JobsService) =>
        new MappingSuggestionsService({ db, audit, jobs }),
      inject: [DB, AuditService, JobsService],
    },
    {
      provide: MappingSuggestWorker,
      useFactory: (jobs: JobsService, db: Db, graph: GraphService, model: TextModel) =>
        new MappingSuggestWorker(jobs, { db, graph, model }),
      inject: [JobsService, DB, GRAPH, TEXT_MODEL],
    },
  ],
})(SuggestModule);
