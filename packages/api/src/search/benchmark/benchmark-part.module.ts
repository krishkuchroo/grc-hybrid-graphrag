// Search part 4, the benchmark runs (S8; D1, D45.8, D46, D73): the routes the benchmark command stores
// a run through, piece by piece, and the Benchmark screen reads it from (`/api/v1/benchmark/runs`,
// S8-002), over the `benchmark_runs` and `benchmark_results` tables (./benchmark.schema.ts). Only the
// org's Admins start, fill, finish and read runs (the role table's `admin` cell), checked in the API
// and again by Postgres row security. Runs in the API program; the module declares its own imports.
// - The routes: ./benchmark-runs.controller.ts. Starting, adding results, finishing and reading, with
//   the audit entries in the same transaction: ./benchmark-runs.service.ts. What the API records
//   about itself in every run's settings (models, prompt versions, limits, cut-offs, injection
//   checks): ./benchmark-settings.ts, with the model names read from AiModule's own clients.
// - The shared model (kinds, metrics, shapes, `summariseBenchmark` and names) is in @grc/shared
//   (packages/shared/src/benchmark/).
import { Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { EMBEDDER, type Embedder } from '../../ai/embedder.js';
import { TEXT_MODEL, type TextModel } from '../../ai/text-model.js';
import { AuditModule } from '../../audit/audit.module.js';
import { AuditService } from '../../audit/audit.service.js';
import type { Db } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { BenchmarkRunsController } from './benchmark-runs.controller.js';
import { BenchmarkRunsService } from './benchmark-runs.service.js';
import { apiRunSettings } from './benchmark-settings.js';

export class BenchmarkPartModule {}
Module({
  imports: [AiModule, AuditModule],
  controllers: [BenchmarkRunsController],
  providers: [
    {
      provide: BenchmarkRunsService,
      useFactory: (db: Db, audit: AuditService, textModel: TextModel, embedder: Embedder) =>
        new BenchmarkRunsService({
          db,
          audit,
          settings: apiRunSettings({ text: textModel.modelName, embedding: embedder.modelName }),
        }),
      inject: [DB, AuditService, TEXT_MODEL, EMBEDDER],
    },
  ],
})(BenchmarkPartModule);
