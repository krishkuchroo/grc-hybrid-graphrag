// The API program's root module (D36): the feature modules, health, the OpenAPI document, and
// jobs in send-only mode.
import { Module } from '@nestjs/common';
import { ConnectionsModule } from './common/connections.module.js';
import { OpenApiController } from './common/openapi.js';
import { FEATURE_MODULES } from './feature-modules.js';
import { HealthModule } from './health/health.controller.js';
import { JobsModule } from './jobs/jobs.module.js';

export class AppModule {}
Module({
  imports: [ConnectionsModule, JobsModule.forApi(), HealthModule, ...FEATURE_MODULES],
  controllers: [OpenApiController],
})(AppModule);
