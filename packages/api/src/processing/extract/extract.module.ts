// Processing part 3, extraction (S4-006): `processing.chunk-extract` asks Gemma for the records and
// links a chunk states (D38, D52), stores the answer on the chunk and queues its resolution
// (./extract.job.ts; the prompt in ./prompt.ts). Its job handler registers in the worker program
// only, one job at a time (D72), and the module declares its own imports: the text model from
// AiModule; the database and the jobs service are global.
import { Module } from '@nestjs/common';
import { AiModule } from '../../ai/ai.module.js';
import { TEXT_MODEL, type TextModel } from '../../ai/text-model.js';
import type { Db } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { JobsService } from '../../jobs/jobs.module.js';
import { ChunkExtractJob } from './extract.job.js';

export class ExtractModule {}
Module({
  imports: [AiModule],
  providers: [
    {
      provide: ChunkExtractJob,
      useFactory: (jobs: JobsService, db: Db, textModel: TextModel) => new ChunkExtractJob(jobs, db, textModel),
      inject: [JobsService, DB, TEXT_MODEL],
    },
  ],
})(ExtractModule);
