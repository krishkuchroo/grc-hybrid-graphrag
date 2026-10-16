// Processing part 1, the reader (S4-004): `processing.document-read` reads a stored document's text
// in the worker's file sandbox and cuts it into chunks (D71), with bge-m3's own tokenizer. Its job
// handler registers in the worker program only (./document-read.job.ts), and the module declares
// its own imports. `pnpm --filter api setup:tokenizer` (./setup-tokenizer.ts) sets the tokenizer up.
import { Module } from '@nestjs/common';
import type { Db } from '../../db/client.js';
import { DB } from '../../db/db.module.js';
import { JobsService } from '../../jobs/jobs.module.js';
import { FILE_STORE, type FileStore } from '../../storage/file-store.js';
import { StorageModule } from '../../storage/storage.module.js';
import { DocumentReaderJob } from './document-read.job.js';

export class ReaderModule {}
Module({
  imports: [StorageModule],
  providers: [
    {
      provide: DocumentReaderJob,
      useFactory: (jobs: JobsService, db: Db, files: FileStore) => new DocumentReaderJob(jobs, db, files),
      inject: [JobsService, DB, FILE_STORE],
    },
  ],
})(ReaderModule);
