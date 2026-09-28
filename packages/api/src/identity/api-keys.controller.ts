// Machine API keys (D54), for an org's Admin only (D50 "admin" row), signed in with MFA checked:
//   POST   /api/v1/api-keys      { name, role, expiresAt } -> 201 { id, key } (the key is shown only here)
//   GET    /api/v1/api-keys      paged, never shows the key or its hash
//   DELETE /api/v1/api-keys/:id  revokes -> 204; another org's key or an unknown ID -> 404
// A request made with an API key can't manage keys, whatever its role: only a person can.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { AccessGuard } from '../access/access.guard.js';
import { Requires } from '../access/requires.decorator.js';
import { ApiError } from '../common/errors.js';
import { documentRoute } from '../common/openapi.js';
import type { Paged } from '../common/paging.js';
import type { OrgContext } from '../db/org-context.js';
import { ApiKeysService, createdKeySchema, keyListSchema, type KeyItem } from './api-keys.service.js';
import type { AuthedRequest } from './session.guard.js';

function adminContext(request: AuthedRequest): OrgContext {
  const p = request.principal;
  if (!p || !request.identity || p.apiKeyId !== undefined) {
    throw new ApiError(403, 'forbidden', 'You do not have permission to do this.');
  }
  return { orgId: p.orgId, userId: p.userId, role: p.role, clearance: p.clearance };
}

export class ApiKeysController {
  constructor(private readonly keys: ApiKeysService) {}

  create(request: AuthedRequest, body: unknown): Promise<{ id: string; key: string }> {
    return this.keys.create(adminContext(request), body);
  }

  list(request: AuthedRequest, query: unknown): Promise<Paged<KeyItem>> {
    return this.keys.list(adminContext(request), query);
  }

  async revoke(request: AuthedRequest, id: string): Promise<void> {
    await this.keys.revoke(adminContext(request), id);
  }
}

const p = ApiKeysController.prototype;
const d = (name: 'create' | 'list' | 'revoke') => Object.getOwnPropertyDescriptor(p, name)!;
Post()(p, 'create', d('create'));
Req()(p, 'create', 0);
Body()(p, 'create', 1);
Get()(p, 'list', d('list'));
Req()(p, 'list', 0);
Query()(p, 'list', 1);
Delete(':id')(p, 'revoke', d('revoke'));
HttpCode(204)(p, 'revoke', d('revoke'));
Req()(p, 'revoke', 0);
Param('id')(p, 'revoke', 1);
Requires('admin', 'edit')(ApiKeysController);
UseGuards(AccessGuard)(ApiKeysController);
Controller('api-keys')(ApiKeysController);
Inject(ApiKeysService)(ApiKeysController, undefined, 0);

documentRoute({
  method: 'post',
  path: '/api-keys',
  summary: 'Create a machine API key (Admin only); the key is shown only in this response',
  response: createdKeySchema,
});
documentRoute({
  method: 'get',
  path: '/api-keys',
  summary: "The org's machine API keys, paged (Admin only); never the keys themselves",
  response: keyListSchema,
});
