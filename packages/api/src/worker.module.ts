// The worker program's root module (D36): the feature modules and jobs in processing mode.
// No HTTP.
import { Module } from '@nestjs/common';
import { ConnectionsModule } from './common/connections.module.js';
import { FEATURE_MODULES } from './feature-modules.js';
import { JobsModule } from './jobs/jobs.module.js';

export class WorkerModule {}
Module({
  imports: [ConnectionsModule, JobsModule.forWorker(), ...FEATURE_MODULES],
})(WorkerModule);
