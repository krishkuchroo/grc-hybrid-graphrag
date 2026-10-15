// The saved import mappings (S3-006, D44, D47), under /api/v1 and with the `uploads` cell (Admin,
// Risk Manager, Compliance Manager and Analyst; the Control Owner, Auditor and Viewer get 403 at the
// guard):
//   GET  /import-mappings        paging and source; sorted by source   -> Paged<MappingOut>
//   GET  /import-mappings/:id                                          -> the MappingOut; 404 when not the org's
//   POST /import-mappings        importMappingSchema + version?         -> 201 the saved mapping; 409 stale_version
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Body, Controller, Get, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AccessGuard } from '../../access/access.guard.js';
import { Requires } from '../../access/requires.decorator.js';
import { documentRoute } from '../../common/openapi.js';
import type { Paged } from '../../common/paging.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import { callerOf } from './imports.controller.js';
import {
  MappingsService,
  mappingListQuerySchema,
  mappingOutSchema,
  pagedMappingsSchema,
  saveMappingBodySchema,
  type MappingOut,
} from './mappings.service.js';

export class MappingsController {
  constructor(private readonly mappings: MappingsService) {}

  list(request: AuthedRequest, query: unknown): Promise<Paged<MappingOut>> {
    return this.mappings.list(callerOf(request), query ?? {});
  }

  get(request: AuthedRequest, id: string): Promise<MappingOut> {
    return this.mappings.get(callerOf(request), id);
  }

  save(request: AuthedRequest, body: unknown): Promise<MappingOut> {
    return this.mappings.save(callerOf(request), body ?? {});
  }
}
{
  const p = MappingsController.prototype;
  const d = (method: keyof MappingsController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Get()(p, 'list', d('list'));
  Req()(p, 'list', 0);
  Query()(p, 'list', 1);

  Get(':id')(p, 'get', d('get'));
  Req()(p, 'get', 0);
  Param('id')(p, 'get', 1);

  Post()(p, 'save', d('save'));
  Req()(p, 'save', 0);
  Body()(p, 'save', 1);

  Requires('uploads', 'use')(MappingsController);
  UseGuards(AccessGuard)(MappingsController);
  Controller('import-mappings')(MappingsController);
  Inject(MappingsService)(MappingsController, undefined, 0);
}

documentRoute({
  method: 'get',
  path: '/import-mappings',
  summary: "List the org's saved column mappings, one per source, sorted by source, paged, with a source filter",
  response: pagedMappingsSchema,
  query: mappingListQuerySchema,
});
documentRoute({
  method: 'get',
  path: '/import-mappings/{id}',
  summary: "Open one of the org's saved column mappings; 404 when missing or another org's",
  response: mappingOutSchema,
});
documentRoute({
  method: 'post',
  path: '/import-mappings',
  summary:
    "Save a source's column mapping: created when the source has none (no version), replaced when version is the saved one's, else 409 stale_version; audited as import_mapping.saved",
  body: saveMappingBodySchema,
  response: mappingOutSchema,
});
