// The hash-chained audit trail (D37, D56). Provides the AuditService (as grc_app) and the Neo4j
// audit outbox (D45.4) to both programs. In the worker program it also registers and schedules
// the nightly chain check (D72) and runs the outbox relay every 2 s for every org (D45.5).
import { Module, type BeforeApplicationShutdown, type OnApplicationBootstrap } from '@nestjs/common';
import { createLogger } from '../common/logger.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { GRAPH } from '../graph/graph.module.js';
import type { GraphService } from '../graph/graph.service.js';
import { JobsService } from '../jobs/jobs.module.js';
import { AuditService } from './audit.service.js';
import { AuditOutbox } from './outbox.js';
import { OutboxRelay } from './outbox-relay.job.js';
import { runVerifyChains, VERIFY_CHAINS_CRON, VERIFY_CHAINS_QUEUE } from './verify-chain.job.js';

export class AuditJobs implements OnApplicationBootstrap, BeforeApplicationShutdown {
  private readonly log = createLogger().child({ context: 'AuditVerifyChains' });
  private relay: OutboxRelay | undefined;

  constructor(
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
    private readonly graph: GraphService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.jobs.processesJobs) return;
    // The orgs to relay are the orgs with an audit partition.
    this.relay = new OutboxRelay({ graph: this.graph, audit: this.audit, orgIds: () => this.audit.orgIds() });
    this.relay.start();
    await this.jobs.work(VERIFY_CHAINS_QUEUE, async () => {
      await runVerifyChains({ audit: this.audit, log: this.log, orgIds: await this.audit.orgIds() });
    });
    await this.jobs.schedule(VERIFY_CHAINS_QUEUE, VERIFY_CHAINS_CRON);
  }

  // Before the connections close, so no pass is cut off mid-way.
  async beforeApplicationShutdown(): Promise<void> {
    await this.relay?.stop();
  }
}

export class AuditModule {}
Module({
  providers: [
    { provide: AuditService, useFactory: (db: Db) => new AuditService(db), inject: [DB] },
    { provide: AuditOutbox, useFactory: (graph: GraphService) => new AuditOutbox(graph), inject: [GRAPH] },
    {
      provide: AuditJobs,
      useFactory: (jobs: JobsService, audit: AuditService, graph: GraphService) => new AuditJobs(jobs, audit, graph),
      inject: [JobsService, AuditService, GRAPH],
    },
  ],
  exports: [AuditService, AuditOutbox],
})(AuditModule);
