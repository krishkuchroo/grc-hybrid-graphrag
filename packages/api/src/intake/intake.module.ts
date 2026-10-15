// Uploads, import mappings and the push API (D40, D44), and the records that first arrive with
// uploads (D202). Audit findings (S3-010): the FindingsService and its routes under
// /api/v1/audit-findings, /api/v1/controls/:id/audit-findings and /api/v1/risks/:id/audit-findings.
// Documents (S3-005): the DocumentsService and its routes under /api/v1/documents (list, get and
// download from the org's own bucket).
// Imports (S3-006): the ImportsService and MappingsService with their routes under /api/v1/imports
// and /api/v1/import-mappings, and the asset-list reader, which only the worker program registers.
// Uploads (S3-004): the UploadsService and POST /api/v1/uploads; the multipart body and the upload
// rate limit are registered on Fastify by the API program (src/main.api.ts).
// Import runs (S3-007): the ImportRunService and POST /api/v1/imports/:id/run, and the asset import
// job, which only the worker program registers; the reader starts a run by itself for a source with
// a saved mapping that fits.
import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuditService } from '../audit/audit.service.js';
import { AuditOutbox } from '../audit/outbox.js';
import type { Db } from '../db/client.js';
import { DB } from '../db/db.module.js';
import { GRAPH } from '../graph/graph.module.js';
import type { GraphService } from '../graph/graph.service.js';
import { JobsService } from '../jobs/jobs.module.js';
import { FILE_STORE, type FileStore } from '../storage/file-store.js';
import { StorageModule } from '../storage/storage.module.js';
import {
  AuditFindingsController,
  ControlAuditFindingsController,
  RiskAuditFindingsController,
} from './audit-findings/findings.controller.js';
import { FindingsService } from './audit-findings/findings.service.js';
import { DocumentsController } from './documents/documents.controller.js';
import { DocumentsService } from './documents/documents.service.js';
import { AssetImportJob } from './imports/asset-import.job.js';
import { AssetListReaderJob } from './imports/asset-list-reader.job.js';
import { ImportsController } from './imports/imports.controller.js';
import { ImportsService } from './imports/imports.service.js';
import { MappingsController } from './imports/mappings.controller.js';
import { MappingsService } from './imports/mappings.service.js';
import { ImportRunController } from './imports/run.controller.js';
import { ImportRunService } from './imports/run.service.js';
import { UploadsController } from './uploads/uploads.controller.js';
import { UploadsService } from './uploads/uploads.service.js';

export class IntakeModule {}
Module({
  imports: [AuditModule, StorageModule],
  controllers: [
    AuditFindingsController,
    ControlAuditFindingsController,
    RiskAuditFindingsController,
    DocumentsController,
    ImportsController,
    ImportRunController,
    MappingsController,
    UploadsController,
  ],
  providers: [
    {
      provide: FindingsService,
      useFactory: (graph: GraphService, outbox: AuditOutbox, db: Db) => new FindingsService({ graph, outbox, db }),
      inject: [GRAPH, AuditOutbox, DB],
    },
    {
      provide: DocumentsService,
      useFactory: (db: Db, audit: AuditService, files: FileStore) => new DocumentsService({ db, audit, files }),
      inject: [DB, AuditService, FILE_STORE],
    },
    { provide: ImportsService, useFactory: (db: Db) => new ImportsService(db), inject: [DB] },
    {
      provide: MappingsService,
      useFactory: (db: Db, audit: AuditService) => new MappingsService({ db, audit }),
      inject: [DB, AuditService],
    },
    {
      provide: UploadsService,
      useFactory: (db: Db, audit: AuditService, files: FileStore, jobs: JobsService) =>
        new UploadsService({ db, audit, files, jobs }),
      inject: [DB, AuditService, FILE_STORE, JobsService],
    },
    {
      provide: ImportRunService,
      useFactory: (db: Db, audit: AuditService, jobs: JobsService) => new ImportRunService({ db, audit, jobs }),
      inject: [DB, AuditService, JobsService],
    },
    {
      provide: AssetListReaderJob,
      useFactory: (jobs: JobsService, db: Db, files: FileStore, audit: AuditService) =>
        new AssetListReaderJob(jobs, db, files, audit),
      inject: [JobsService, DB, FILE_STORE, AuditService],
    },
    {
      provide: AssetImportJob,
      useFactory: (
        jobs: JobsService,
        db: Db,
        graph: GraphService,
        outbox: AuditOutbox,
        audit: AuditService,
        files: FileStore,
      ) => new AssetImportJob(jobs, { db, graph, outbox, audit, files }),
      inject: [JobsService, DB, GRAPH, AuditOutbox, AuditService, FILE_STORE],
    },
  ],
  exports: [FindingsService, DocumentsService, ImportsService, ImportRunService, MappingsService, UploadsService],
})(IntakeModule);
