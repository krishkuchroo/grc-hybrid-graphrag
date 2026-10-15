// The import run route (S3-007, D44, D47), under /api/v1 with the `uploads` cell (Admin, Risk
// Manager, Compliance Manager and Analyst; the Control Owner, Auditor and Viewer get 403 at the
// guard):
//   POST /imports/:id/run   { mapping, saveForSource }   -> 202 { jobId }
//     400 validation_failed · 403 forbidden · 404 not_found · 409 import_busy / import_not_ready
// The service checks `canImportAssets`, the role's asset view and the label, and RLS checks the org,
// role and label again. The org, role and clearance always come from `request.principal`.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Body, Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { AccessGuard } from '../../access/access.guard.js';
import { Requires } from '../../access/requires.decorator.js';
import { documentRoute } from '../../common/openapi.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import { callerOf } from './imports.controller.js';
import { ImportRunService, runImportBodySchema, runStartedSchema, type RunStarted } from './run.service.js';

export class ImportRunController {
  constructor(private readonly runs: ImportRunService) {}

  run(request: AuthedRequest, id: string, body: unknown): Promise<RunStarted> {
    return this.runs.run(callerOf(request), id, body ?? {});
  }
}
{
  const p = ImportRunController.prototype;
  const d = (method: keyof ImportRunController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Post(':id/run')(p, 'run', d('run'));
  HttpCode(202)(p, 'run', d('run'));
  Req()(p, 'run', 0);
  Param('id')(p, 'run', 1);
  Body()(p, 'run', 2);

  Requires('uploads', 'use')(ImportRunController);
  UseGuards(AccessGuard)(ImportRunController);
  Controller('imports')(ImportRunController);
  Inject(ImportRunService)(ImportRunController, undefined, 0);
}

documentRoute({
  method: 'post',
  path: '/imports/{id}/run',
  summary:
    "Run an asset-list import with a mapping (our field -> the file's column), optionally saving it as the source's mapping: 202 with the job ID. The worker creates and updates the assets (origin import, matched by source ID) and draws their HOSTS and RUNS links, audited. Needs status needs_mapping or done (a re-run); 409 import_busy while queued or importing; 400 when the mapping names a column the file lacks; 404 when missing or hidden",
  body: runImportBodySchema,
  response: runStartedSchema,
  responses: { '202': { description: 'Accepted: the import is queued', schema: runStartedSchema } },
});
