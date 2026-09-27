// The hash-chained audit trail (D37, D56). Provides the AuditService (as grc_app) to both
// programs. In the worker program it also registers and schedules the nightly chain check (D72).
import { Module, type OnApplicationBootstrap } from '@nestjs/common';
import { createLogger } from '../common/logger.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { JobsService } from '../jobs/jobs.module.js';
import { AuditService } from './audit.service.js';
import { runVerifyChains, VERIFY_CHAINS_CRON, VERIFY_CHAINS_QUEUE } from './verify-chain.job.js';

export class AuditJobs implements OnApplicationBootstrap {
  private readonly log = createLogger().child({ context: 'AuditVerifyChains' });

  constructor(
    private readonly jobs: JobsService,
    private readonly audit: AuditService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.jobs.processesJobs) return;
    await this.jobs.work(VERIFY_CHAINS_QUEUE, async () => {
      await runVerifyChains({ audit: this.audit, log: this.log, orgIds: await this.audit.orgIds() });
    });
    await this.jobs.schedule(VERIFY_CHAINS_QUEUE, VERIFY_CHAINS_CRON);
  }
}

export class AuditModule {}
Module({
  providers: [
    { provide: AuditService, useFactory: (db: Db) => new AuditService(db), inject: [DB] },
    {
      provide: AuditJobs,
      useFactory: (jobs: JobsService, audit: AuditService) => new AuditJobs(jobs, audit),
      inject: [JobsService, AuditService],
    },
  ],
  exports: [AuditService],
})(AuditModule);
