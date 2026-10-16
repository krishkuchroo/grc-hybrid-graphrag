// Processing part 2, embedding (S4-005): `processing.document-embed` gives each chunk its bge-m3
// vector and hands the chunks on (./document-embed.job.ts), and a sweep gives records their name
// embeddings and queues their duplicate checks (D70, D203; ./name-embedding-sweep.ts). Both run in
// the worker program only; the module declares its own imports (the embedder from AiModule, the
// org list from AuditModule; Postgres, Neo4j and the jobs are global).
import { Module, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { EMBEDDER, type Embedder } from '../../ai/embedder.js';
import { AuditModule } from '../../audit/audit.module.js';
import { AuditService } from '../../audit/audit.service.js';
import { createLogger } from '../../common/logger.js';
import type { Db } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { GRAPH } from '../../graph/graph.module.js';
import type { GraphService } from '../../graph/graph.service.js';
import { JobsService } from '../../jobs/jobs.module.js';
import { DocumentEmbedJob } from './document-embed.job.js';
import { NameEmbeddingSweep } from './name-embedding-sweep.js';

/** Starts the name embedding sweep in the worker program and stops it before the connections close. */
export class NameEmbeddingSweepJob implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private sweep: NameEmbeddingSweep | undefined;

  constructor(
    private readonly jobs: JobsService,
    private readonly db: Db,
    private readonly graph: GraphService,
    private readonly audit: AuditService,
    private readonly embedder: Embedder,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.jobs.processesJobs) return;
    this.sweep = new NameEmbeddingSweep({
      graph: this.graph,
      db: this.db,
      jobs: this.jobs,
      embedder: this.embedder,
      // The orgs to sweep are the orgs with an audit partition, as for the outbox relay.
      orgIds: () => this.audit.orgIds(),
      log: createLogger(),
    });
    this.sweep.start();
  }

  async beforeApplicationShutdown(): Promise<void> {
    await this.sweep?.stop();
  }
}

export class EmbedModule {}
Module({
  imports: [AiModule, AuditModule],
  providers: [
    {
      provide: DocumentEmbedJob,
      useFactory: (jobs: JobsService, db: Db, embedder: Embedder) => new DocumentEmbedJob(jobs, db, embedder),
      inject: [JobsService, DB, EMBEDDER],
    },
    {
      provide: NameEmbeddingSweepJob,
      useFactory: (jobs: JobsService, db: Db, graph: GraphService, audit: AuditService, embedder: Embedder) =>
        new NameEmbeddingSweepJob(jobs, db, graph, audit, embedder),
      inject: [JobsService, DB, GRAPH, AuditService, EMBEDDER],
    },
  ],
})(EmbedModule);
