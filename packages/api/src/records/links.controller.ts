// The links routes (S1-005):
//   POST /api/v1/links                 { type, fromId, toId } -> 201 with the link. Any signed-in user
//                                      may call it; the service decides (D200 depends on both ends).
//   POST /api/v1/links/remove          { type, fromId, toId } -> 200 with the removed link (S1-011,
//                                      D201); an `ai` link is 409 `ai_link_review_only` (D207).
//   GET  /api/v1/<plural>/:id/links    the record's links whose other end the caller can see.
//   GET  /api/v1/assets/:id/map        the HOSTS/RUNS map around one asset (D204).
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { RECORD_KINDS, RECORD_PATHS, ROLE_TABLE, type RecordKind } from '@grc/shared';
import { AccessGuard } from '../access/access.guard.js';
import { Requires } from '../access/requires.decorator.js';
import { ApiError } from '../common/errors.js';
import { documentRoute } from '../common/openapi.js';
import type { AuthedRequest } from '../identity/session.guard.js';
import { assetMapSchema, mapQuerySchema, type AssetMap } from './asset-map.js';
import {
  LinksService,
  createLinkSchema,
  linkListSchema,
  linkSchema,
  removeLinkSchema,
  removedLinkSchema,
  type LinkItem,
  type LinkOut,
  type RemovedLink,
} from './links.service.js';
import type { Caller } from './records.service.js';

function callerOf(request: AuthedRequest): Caller {
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

export class LinksController {
  constructor(private readonly links: LinksService) {}

  create(request: AuthedRequest, body: unknown): Promise<LinkOut> {
    return this.links.create(callerOf(request), body);
  }

  remove(request: AuthedRequest, body: unknown): Promise<RemovedLink> {
    return this.links.remove(callerOf(request), body);
  }
}
{
  const p = LinksController.prototype;
  Post()(p, 'create', Object.getOwnPropertyDescriptor(p, 'create')!);
  Req()(p, 'create', 0);
  Body()(p, 'create', 1);
  Post('remove')(p, 'remove', Object.getOwnPropertyDescriptor(p, 'remove')!);
  HttpCode(200)(p, 'remove', Object.getOwnPropertyDescriptor(p, 'remove')!);
  Req()(p, 'remove', 0);
  Body()(p, 'remove', 1);
  Controller('links')(LinksController);
  Inject(LinksService)(LinksController, undefined, 0);
}

interface RecordLinksController {
  list(request: AuthedRequest, id: string): Promise<{ items: LinkItem[] }>;
}

/** GET /api/v1/<plural>/:id/links for one kind, with that kind's `view` cell. An "own" cell (a
 * Control Owner's controls) passes the guard and the service checks ownership. */
function recordLinksController(kind: RecordKind): new (links: LinksService) => RecordLinksController {
  const name = `${kind[0]!.toUpperCase()}${kind.slice(1)}LinksController`;
  const cls = {
    [name]: class {
      constructor(readonly links: LinksService) {}

      list(request: AuthedRequest, id: string): Promise<{ items: LinkItem[] }> {
        return this.links.list(callerOf(request), kind, id);
      }
    },
  }[name]!;
  const p = cls.prototype;
  const own = Object.values(ROLE_TABLE[kind]).includes('edit_own');
  Get(':id/links')(p, 'list', Object.getOwnPropertyDescriptor(p, 'list')!);
  Req()(p, 'list', 0);
  Param('id')(p, 'list', 1);
  Requires(kind, 'view', own ? { own: true } : undefined)(cls);
  UseGuards(AccessGuard)(cls);
  Controller(RECORD_PATHS[kind])(cls);
  Inject(LinksService)(cls, undefined, 0);
  return cls;
}

export const RECORD_LINKS_CONTROLLERS = RECORD_KINDS.map(recordLinksController);

export class AssetMapController {
  constructor(private readonly links: LinksService) {}

  map(request: AuthedRequest, id: string, query: unknown): Promise<AssetMap> {
    return this.links.map(callerOf(request), id, query);
  }
}
{
  const p = AssetMapController.prototype;
  Get(':id/map')(p, 'map', Object.getOwnPropertyDescriptor(p, 'map')!);
  Req()(p, 'map', 0);
  Param('id')(p, 'map', 1);
  Query()(p, 'map', 2);
  Requires('asset', 'view')(AssetMapController);
  UseGuards(AccessGuard)(AssetMapController);
  Controller(RECORD_PATHS.asset)(AssetMapController);
  Inject(LinksService)(AssetMapController, undefined, 0);
}

documentRoute({
  method: 'post',
  path: '/links',
  summary: 'Link two records (D200: the caller can edit either and see both)',
  body: createLinkSchema,
  response: linkSchema,
});
documentRoute({
  method: 'post',
  path: '/links/remove',
  summary:
    'Remove a link added by mistake (D201: the same people who may add it). Answers 404 not_found, 403 forbidden, or 409 ai_link_review_only for a link found by the AI (D207)',
  body: removeLinkSchema,
  response: removedLinkSchema,
});
for (const kind of RECORD_KINDS) {
  documentRoute({
    method: 'get',
    path: `/${RECORD_PATHS[kind]}/{id}/links`,
    summary: `The ${kind}'s links whose other end the caller can see`,
    response: linkListSchema,
  });
}
documentRoute({
  method: 'get',
  path: '/assets/{id}/map',
  summary: 'The HOSTS and RUNS map around one asset: depth 1 to 3 (default 2), at most 200 assets',
  response: assetMapSchema,
  query: mapQuerySchema,
});
