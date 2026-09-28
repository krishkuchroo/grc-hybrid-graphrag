// The record routes (S1-004, D47): for each of the five kinds, with `P` its plural path,
//   GET   /api/v1/P              view   the S1-003 list query        -> Paged<Record>
//   GET   /api/v1/P/:id          view                                -> the record; 404 when not visible
//   POST  /api/v1/P              edit   the create schema            -> 201 the record
//   PATCH /api/v1/P/:id          edit   the update schema + version  -> the record; 409 stale_version
//   POST  /api/v1/P/:id/retire   edit   { version }                  -> the record
// One controller per kind comes from `recordsController(kind)`, so each route has a fixed
// `@Requires(kind, 'view'|'edit')`. The control routes carry the `own` flag: a Control Owner passes
// the guard and the RecordsService limits them to the controls they own (404 otherwise, D50, D199,
// D206). The org, role and clearance always come from `request.principal`, never from the request.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Body, Controller, HttpCode, Inject, Param, Patch, Post, Get, Query, Req, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  RECORD_KINDS,
  RECORD_PATHS,
  createSchemas,
  recordSchemas,
  updateSchemas,
  type Label,
  type RecordKind,
  type Role,
} from '@grc/shared';
import { AccessGuard } from '../access/access.guard.js';
import { Requires } from '../access/requires.decorator.js';
import { ApiError } from '../common/errors.js';
import { documentRoute } from '../common/openapi.js';
import type { Paged } from '../common/paging.js';
import type { AuthedRequest } from '../identity/session.guard.js';
import { RecordsService, type Caller, type RecordOut } from './records.service.js';

/** The body of `POST /api/v1/P/:id/retire`. */
export const retireBodySchema = z.strictObject({ version: z.int().min(1) });

const ratingSchema = z.object({ score: z.number(), band: z.string() });

/** A record as the routes answer it; a risk also carries its rating (D197). */
function answerSchema(kind: RecordKind): z.ZodType {
  return kind === 'risk' ? recordSchemas.risk.extend({ rating: ratingSchema }) : recordSchemas[kind];
}

function pagedSchema(item: z.ZodType): z.ZodType {
  return z.object({ items: z.array(item), page: z.int(), pageSize: z.int(), total: z.int() });
}

function callerOf(request: AuthedRequest): Caller {
  const p = request.principal;
  if (!p) throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
  return {
    orgId: p.orgId,
    userId: p.userId,
    role: p.role as Role,
    clearance: p.clearance as Label,
    ...(p.apiKeyId !== undefined ? { apiKeyId: p.apiKeyId } : {}),
  };
}

export interface RecordsRoutes {
  list(request: AuthedRequest, query: unknown): Promise<Paged<RecordOut>>;
  get(request: AuthedRequest, id: string): Promise<RecordOut>;
  create(request: AuthedRequest, body: unknown): Promise<RecordOut>;
  update(request: AuthedRequest, id: string, body: unknown): Promise<RecordOut>;
  retire(request: AuthedRequest, id: string, body: unknown): Promise<RecordOut>;
}

/** The controller class for one kind's five routes. */
export function recordsController(kind: RecordKind): new (records: RecordsService) => RecordsRoutes {
  class KindController implements RecordsRoutes {
    constructor(private readonly records: RecordsService) {}

    list(request: AuthedRequest, query: unknown): Promise<Paged<RecordOut>> {
      return this.records.list(callerOf(request), kind, query ?? {});
    }

    get(request: AuthedRequest, id: string): Promise<RecordOut> {
      return this.records.get(callerOf(request), kind, id);
    }

    create(request: AuthedRequest, body: unknown): Promise<RecordOut> {
      return this.records.create(callerOf(request), kind, body ?? {});
    }

    update(request: AuthedRequest, id: string, body: unknown): Promise<RecordOut> {
      return this.records.update(callerOf(request), kind, id, body ?? {});
    }

    retire(request: AuthedRequest, id: string, body: unknown): Promise<RecordOut> {
      const { version } = retireBodySchema.parse(body ?? {});
      return this.records.retire(callerOf(request), kind, id, version);
    }
  }
  const name = `${kind[0]!.toUpperCase()}${kind.slice(1)}RecordsController`;
  Object.defineProperty(KindController, 'name', { value: name });

  const own = kind === 'control' ? { own: true } : undefined;
  const p = KindController.prototype;
  const d = (method: keyof RecordsRoutes) => Object.getOwnPropertyDescriptor(p, method)!;

  Get()(p, 'list', d('list'));
  Requires(kind, 'view', own)(p, 'list', d('list'));
  Req()(p, 'list', 0);
  Query()(p, 'list', 1);

  Get(':id')(p, 'get', d('get'));
  Requires(kind, 'view', own)(p, 'get', d('get'));
  Req()(p, 'get', 0);
  Param('id')(p, 'get', 1);

  Post()(p, 'create', d('create'));
  HttpCode(201)(p, 'create', d('create'));
  Requires(kind, 'edit', own)(p, 'create', d('create'));
  Req()(p, 'create', 0);
  Body()(p, 'create', 1);

  Patch(':id')(p, 'update', d('update'));
  Requires(kind, 'edit', own)(p, 'update', d('update'));
  Req()(p, 'update', 0);
  Param('id')(p, 'update', 1);
  Body()(p, 'update', 2);

  Post(':id/retire')(p, 'retire', d('retire'));
  HttpCode(200)(p, 'retire', d('retire'));
  Requires(kind, 'edit', own)(p, 'retire', d('retire'));
  Req()(p, 'retire', 0);
  Param('id')(p, 'retire', 1);
  Body()(p, 'retire', 2);

  UseGuards(AccessGuard)(KindController);
  Controller(RECORD_PATHS[kind])(KindController);
  Inject(RecordsService)(KindController, undefined, 0);

  const path = `/${RECORD_PATHS[kind]}`;
  const record = answerSchema(kind);
  documentRoute({ method: 'get', path, summary: `List ${RECORD_PATHS[kind]}, paged`, response: pagedSchema(record) });
  documentRoute({ method: 'get', path: `${path}/{id}`, summary: `Open one ${kind}`, response: record });
  documentRoute({
    method: 'post',
    path,
    summary: `Create a ${kind}`,
    body: createSchemas[kind],
    response: record,
  });
  documentRoute({
    method: 'patch',
    path: `${path}/{id}`,
    summary: `Edit a ${kind}; a stale version is refused (409 stale_version)`,
    body: updateSchemas[kind],
    response: record,
  });
  documentRoute({
    method: 'post',
    path: `${path}/{id}/retire`,
    summary: `Retire a ${kind}; it is kept, never deleted`,
    body: retireBodySchema,
    response: record,
  });

  return KindController;
}

/** One controller per kind. */
export const RECORDS_CONTROLLERS = RECORD_KINDS.map((kind) => recordsController(kind));
