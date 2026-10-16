// The mapping-suggestions route (S4-009; D16 (b), D20, D47, D50, D212 (3), (4)), under /api/v1:
//   POST /mappings/suggestions  { kind: 'controls', framework } | { kind: 'soc2_to_nist' }
//     -> 202 { status: 'started', jobId } | { status: 'already_running', jobId: null }
//     400 validation_failed · 403 forbidden
// It needs the Framework-mappings `edit` cell (Admin and Compliance Manager); the guard refuses
// every other role before anything runs, and the service checks `canSuggestMappings` again. The
// org, role and clearance always come from `request.principal`.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Body, Controller, HttpCode, Inject, Post, Req, UseGuards } from '@nestjs/common';
import { AccessGuard } from '../../access/access.guard.js';
import { Requires } from '../../access/requires.decorator.js';
import { ApiError } from '../../common/errors.js';
import { documentRoute } from '../../common/openapi.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import type { Caller } from '../../records/records.service.js';
import {
  MappingSuggestionsService,
  mappingSuggestionsBodySchema,
  mappingSuggestionsStartedSchema,
  type MappingSuggestionsStarted,
} from './suggestions.service.js';

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

export class MappingSuggestionsController {
  constructor(private readonly suggestions: MappingSuggestionsService) {}

  start(request: AuthedRequest, body: unknown): Promise<MappingSuggestionsStarted> {
    return this.suggestions.start(callerOf(request), body);
  }
}
{
  const p = MappingSuggestionsController.prototype;
  const d = (name: string): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, name)!;
  Post('suggestions')(p, 'start', d('start'));
  HttpCode(202)(p, 'start', d('start'));
  Req()(p, 'start', 0);
  Body()(p, 'start', 1);
  Requires('framework_mapping', 'edit')(MappingSuggestionsController);
  UseGuards(AccessGuard)(MappingSuggestionsController);
  Controller('mappings')(MappingSuggestionsController);
  Inject(MappingSuggestionsService)(MappingSuggestionsController, undefined, 0);
}

documentRoute({
  method: 'post',
  path: '/mappings/suggestions',
  summary:
    "Start AI mapping suggestions in the background (Admins and Compliance Managers): `controls` suggests which requirements of one framework each of your controls satisfies (SATISFIES); `soc2_to_nist` suggests which NIST SP 800-53 controls each SOC 2 criterion maps to (MAPS_TO). The local AI picks from the 5 closest catalog items by name, and every suggestion waits in the Analyst's review queue; nothing is linked until it is approved. Answers 202 `started` with the job ID, or 202 `already_running` with no new job while the same run is queued or running; 403 forbidden for any other role",
  body: mappingSuggestionsBodySchema,
  response: mappingSuggestionsStartedSchema,
  responses: {
    '202': { description: 'Accepted: the run is queued, or already running', schema: mappingSuggestionsStartedSchema },
  },
});
