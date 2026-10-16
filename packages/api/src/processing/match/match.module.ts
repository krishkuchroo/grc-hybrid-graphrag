// Processing part 4, duplicate matching (S4-007): ties names to existing records (exact, close
// spelling, close meaning; D43), and `processing.record-dedupe` merges or flags records that
// duplicate each other. Its job handlers register in the worker program only, and the module
// declares its own imports.
// - NameMatcher (./name-matcher.ts): what a name as written in a document means, in the view of
//   the person behind the work; exported for the rule checks (S4-008).
// - RecordDedupeJob (./record-dedupe.job.ts): the duplicate check, 4 at once, worker only.
import { Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { EMBEDDER, type Embedder } from '../../ai/embedder.js';
import { AuditModule } from '../../audit/audit.module.js';
import { AuditOutbox } from '../../audit/outbox.js';
import type { Db } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { GRAPH } from '../../graph/graph.module.js';
import type { GraphService } from '../../graph/graph.service.js';
import { JobsService } from '../../jobs/jobs.module.js';
import { NameMatcher } from './name-matcher.js';
import { RecordDedupeJob } from './record-dedupe.job.js';

export class MatchModule {}
Module({
  imports: [AuditModule, AiModule],
  providers: [
    {
      provide: NameMatcher,
      useFactory: (graph: GraphService, embedder: Embedder) => new NameMatcher({ graph, embedder }),
      inject: [GRAPH, EMBEDDER],
    },
    {
      provide: RecordDedupeJob,
      useFactory: (jobs: JobsService, db: Db, graph: GraphService, outbox: AuditOutbox) =>
        new RecordDedupeJob(jobs, { db, graph, outbox }),
      inject: [JobsService, DB, GRAPH, AuditOutbox],
    },
  ],
  exports: [NameMatcher],
})(MatchModule);
