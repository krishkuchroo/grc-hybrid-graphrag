// Processing part 5, the rule checks (S4-008): `processing.chunk-resolve` checks each extracted link
// (D39); confident ones go live in Neo4j, the rest wait in the review queue (./chunk-resolve.job.ts;
// the pure rules in ./decide-rules.ts, the live links in ./live-links.ts). Its job handler registers
// in the worker program only, 4 at once (D72), and the module declares its own imports: the name
// matcher from MatchModule, the audit outbox from AuditModule; the database, Neo4j and the jobs
// service are global.
import { Module } from '@nestjs/common';
import { AuditModule } from '../../audit/audit.module.js';
import { AuditOutbox } from '../../audit/outbox.js';
import type { Db } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { GRAPH } from '../../graph/graph.module.js';
import type { GraphService } from '../../graph/graph.service.js';
import { JobsService } from '../../jobs/jobs.module.js';
import { MatchModule } from '../match/match.module.js';
import { NameMatcher } from '../match/name-matcher.js';
import { ChunkResolveJob } from './chunk-resolve.job.js';

export class DecideModule {}
Module({
  imports: [MatchModule, AuditModule],
  providers: [
    {
      provide: ChunkResolveJob,
      useFactory: (jobs: JobsService, db: Db, graph: GraphService, outbox: AuditOutbox, matcher: NameMatcher) =>
        new ChunkResolveJob(jobs, { db, graph, outbox, matcher }),
      inject: [JobsService, DB, GRAPH, AuditOutbox, NameMatcher],
    },
  ],
})(DecideModule);
