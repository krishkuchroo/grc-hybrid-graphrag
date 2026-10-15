// The mapping routes (S2-005, D212 (3)):
//   POST /api/v1/mappings         { controlId, requirementId } -> 201 with the SATISFIES link.
//   POST /api/v1/mappings/remove  { controlId, requirementId } -> 200 with the removed link; an
//                                 `ai` mapping is 409 `ai_link_review_only` (D207).
// Both need the Framework-mappings `edit` cell (D50: Admin and Compliance Manager). The guard
// refuses every other role before any lookup, the Control Owner on their own control included
// (D212 (3)), and the service then checks the two records and `canMapControl`.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { AccessGuard } from '../access/access.guard.js';
import { Requires } from '../access/requires.decorator.js';
import { ApiError } from '../common/errors.js';
import { documentRoute } from '../common/openapi.js';
import type { AuthedRequest } from '../identity/session.guard.js';
import type { Caller } from '../records/records.service.js';
import {
  MappingsService,
  mappingBodySchema,
  mappingSchema,
  removedMappingSchema,
  type MappingOut,
  type RemovedMapping,
} from './mappings.service.js';

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

export class MappingsController {
  constructor(private readonly mappings: MappingsService) {}

  create(request: AuthedRequest, body: unknown): Promise<MappingOut> {
    return this.mappings.create(callerOf(request), body);
  }

  remove(request: AuthedRequest, body: unknown): Promise<RemovedMapping> {
    return this.mappings.remove(callerOf(request), body);
  }
}
{
  const p = MappingsController.prototype;
  const d = (name: string): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, name)!;
  Post()(p, 'create', d('create'));
  HttpCode(201)(p, 'create', d('create'));
  Req()(p, 'create', 0);
  Body()(p, 'create', 1);
  Post('remove')(p, 'remove', d('remove'));
  HttpCode(200)(p, 'remove', d('remove'));
  Req()(p, 'remove', 0);
  Body()(p, 'remove', 1);
  Requires('framework_mapping', 'edit')(MappingsController);
  UseGuards(AccessGuard)(MappingsController);
  Controller('mappings')(MappingsController);
  Inject(MappingsService)(MappingsController, undefined, 0);
}

documentRoute({
  method: 'post',
  path: '/mappings',
  summary:
    'Record that a control satisfies a requirement (D212 (3): Admins and Compliance Managers, for a control they can see). Answers 404 not_found, 403 forbidden, or 409 link_exists',
  body: mappingBodySchema,
  response: mappingSchema,
});
documentRoute({
  method: 'post',
  path: '/mappings/remove',
  summary:
    'Take a mapping back (the same people who may add one). Answers 404 not_found, 403 forbidden, or 409 ai_link_review_only for a mapping suggested by the AI (D207)',
  body: mappingBodySchema,
  response: removedMappingSchema,
});
