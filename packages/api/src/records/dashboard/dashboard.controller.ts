// GET /api/v1/dashboard (S8-008, D27 #1, D47): the Home dashboard's counts, for any signed-in
// person or API key, only from what they may see. The global session guard signs them in; the
// service picks the sections from the role table and counts as the caller. The org, role and
// clearance always come from `request.principal`, never from the request.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Controller, Get, Inject, Req } from '@nestjs/common';
import { dashboardSchema, type Dashboard } from '@grc/shared';
import { ApiError } from '../../common/errors.js';
import { documentRoute } from '../../common/openapi.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import type { Caller } from '../records.service.js';
import { DashboardService } from './dashboard.service.js';

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

export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  get(request: AuthedRequest): Promise<Dashboard> {
    return this.dashboard.get(callerOf(request));
  }
}
{
  const p = DashboardController.prototype;
  Get()(p, 'get', Object.getOwnPropertyDescriptor(p, 'get')!);
  Req()(p, 'get', 0);
  Controller('dashboard')(DashboardController);
  Inject(DashboardService)(DashboardController, undefined, 0);
}

documentRoute({
  method: 'get',
  path: '/dashboard',
  summary:
    "The Home dashboard's counts of the active records the caller may see: risks (per band, heat map, untreated, top 5), controls, open incidents (newest 5), assets, policies, open and overdue audit findings, expiring and expired evidence, and documents per status; a section only when the role views its record type",
  response: dashboardSchema,
});
