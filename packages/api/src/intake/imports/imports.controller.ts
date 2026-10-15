// The import routes (S3-006, D44, D47), under /api/v1 and with the `uploads` cell (Admin, Risk
// Manager, Compliance Manager and Analyst; the Control Owner, Auditor and Viewer get 403 at the
// guard):
//   GET /imports        paging, status, source; newest first   -> Paged<ImportOut>
//   GET /imports/:id                                            -> the ImportOut; 404 when hidden
// The service checks the role's asset view and the label, and RLS checks both again. The org, role
// and clearance always come from `request.principal`.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { AccessGuard } from '../../access/access.guard.js';
import { Requires } from '../../access/requires.decorator.js';
import { ApiError } from '../../common/errors.js';
import { documentRoute } from '../../common/openapi.js';
import type { Paged } from '../../common/paging.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import type { Caller } from '../../records/records.service.js';
import {
  ImportsService,
  importListQuerySchema,
  importOutSchema,
  pagedImportsSchema,
  type ImportOut,
} from './imports.service.js';

/** The caller from the request's principal (403 without one). */
export function callerOf(request: AuthedRequest): Caller {
  const p = request.principal;
  if (!p) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
  return {
    orgId: p.orgId,
    userId: p.userId,
    role: p.role,
    clearance: p.clearance,
    ...(p.apiKeyId !== undefined ? { apiKeyId: p.apiKeyId } : {}),
  };
}

export class ImportsController {
  constructor(private readonly imports: ImportsService) {}

  list(request: AuthedRequest, query: unknown): Promise<Paged<ImportOut>> {
    return this.imports.list(callerOf(request), query ?? {});
  }

  get(request: AuthedRequest, id: string): Promise<ImportOut> {
    return this.imports.get(callerOf(request), id);
  }
}
{
  const p = ImportsController.prototype;
  const d = (method: keyof ImportsController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Get()(p, 'list', d('list'));
  Req()(p, 'list', 0);
  Query()(p, 'list', 1);

  Get(':id')(p, 'get', d('get'));
  Req()(p, 'get', 0);
  Param('id')(p, 'get', 1);

  Requires('uploads', 'use')(ImportsController);
  UseGuards(AccessGuard)(ImportsController);
  Controller('imports')(ImportsController);
  Inject(ImportsService)(ImportsController, undefined, 0);
}

documentRoute({
  method: 'get',
  path: '/imports',
  summary:
    'List the asset-list imports the caller can see, newest first, paged, with status and source filters; each with its columns, sample, row count, and the saved or suggested mapping',
  response: pagedImportsSchema,
  query: importListQuerySchema,
});
documentRoute({
  method: 'get',
  path: '/imports/{id}',
  summary:
    "Open one asset-list import: its columns, 5 sample rows, row count, status, counts and errors, plus the source's saved mapping when it fits the columns, else the suggested one (mappingFrom); 404 when missing or hidden",
  response: importOutSchema,
});
