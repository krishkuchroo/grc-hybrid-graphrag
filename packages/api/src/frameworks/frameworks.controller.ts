// The frameworks read routes (S2-004, D47), all under /api/v1:
//   GET /frameworks                   framework_mapping view  every active framework with its counts
//   GET /frameworks/:id               framework_mapping view  one framework with its counts; 404 when hidden
//   GET /frameworks/:id/requirements  framework_mapping view  its requirements, paged, with filters and search
//   GET /requirements/:id             framework_mapping view  one requirement, its controls and its MAPS_TO links
//   GET /controls/:id/requirements    control view (own)      the requirements a control satisfies
// Every role views framework mappings (D50), so the first four are open to every signed-in role; the
// last follows the control row, and a Control Owner passes the guard through S1-004's "own" flag
// and the service limits them to their own controls (404 otherwise). The org, role and clearance
// always come from `request.principal`, never from the request.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { AccessGuard } from '../access/access.guard.js';
import { Requires } from '../access/requires.decorator.js';
import { ApiError } from '../common/errors.js';
import { documentRoute } from '../common/openapi.js';
import type { Paged } from '../common/paging.js';
import type { AuthedRequest } from '../identity/session.guard.js';
import type { Caller } from '../records/records.service.js';
import { requirementListQuerySchema } from './framework-queries.js';
import {
  FrameworksService,
  controlRequirementListSchema,
  frameworkListSchema,
  frameworkSummarySchema,
  pagedRequirementsSchema,
  requirementDetailSchema,
  type ControlRequirement,
  type FrameworkSummary,
  type RequirementDetail,
  type RequirementRow,
} from './frameworks.service.js';

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

type Methods<T> = { [K in keyof T]: T[K] extends (...args: never[]) => unknown ? K : never }[keyof T];

function descriptor<T extends object>(proto: T, method: Methods<T> & string): PropertyDescriptor {
  return Object.getOwnPropertyDescriptor(proto, method)!;
}

export class FrameworksController {
  constructor(private readonly frameworks: FrameworksService) {}

  list(request: AuthedRequest): Promise<{ items: FrameworkSummary[] }> {
    return this.frameworks.listFrameworks(callerOf(request));
  }

  get(request: AuthedRequest, id: string): Promise<FrameworkSummary> {
    return this.frameworks.getFramework(callerOf(request), id);
  }

  requirements(request: AuthedRequest, id: string, query: unknown): Promise<Paged<RequirementRow>> {
    return this.frameworks.listRequirements(callerOf(request), id, query ?? {});
  }
}
{
  const p = FrameworksController.prototype;
  Get()(p, 'list', descriptor(p, 'list'));
  Req()(p, 'list', 0);
  Get(':id')(p, 'get', descriptor(p, 'get'));
  Req()(p, 'get', 0);
  Param('id')(p, 'get', 1);
  Get(':id/requirements')(p, 'requirements', descriptor(p, 'requirements'));
  Req()(p, 'requirements', 0);
  Param('id')(p, 'requirements', 1);
  Query()(p, 'requirements', 2);
  Requires('framework_mapping', 'view')(FrameworksController);
  UseGuards(AccessGuard)(FrameworksController);
  Controller('frameworks')(FrameworksController);
  Inject(FrameworksService)(FrameworksController, undefined, 0);
}

export class RequirementsController {
  constructor(private readonly frameworks: FrameworksService) {}

  get(request: AuthedRequest, id: string): Promise<RequirementDetail> {
    return this.frameworks.getRequirement(callerOf(request), id);
  }
}
{
  const p = RequirementsController.prototype;
  Get(':id')(p, 'get', descriptor(p, 'get'));
  Req()(p, 'get', 0);
  Param('id')(p, 'get', 1);
  Requires('framework_mapping', 'view')(RequirementsController);
  UseGuards(AccessGuard)(RequirementsController);
  Controller('requirements')(RequirementsController);
  Inject(FrameworksService)(RequirementsController, undefined, 0);
}

export class ControlRequirementsController {
  constructor(private readonly frameworks: FrameworksService) {}

  list(request: AuthedRequest, id: string): Promise<{ items: ControlRequirement[] }> {
    return this.frameworks.controlRequirements(callerOf(request), id);
  }
}
{
  const p = ControlRequirementsController.prototype;
  Get(':id/requirements')(p, 'list', descriptor(p, 'list'));
  Req()(p, 'list', 0);
  Param('id')(p, 'list', 1);
  Requires('control', 'view', { own: true })(ControlRequirementsController);
  UseGuards(AccessGuard)(ControlRequirementsController);
  Controller('controls')(ControlRequirementsController);
  Inject(FrameworksService)(ControlRequirementsController, undefined, 0);
}

documentRoute({
  method: 'get',
  path: '/frameworks',
  summary: 'The active frameworks, each with its requirement, covered and implemented counts for the caller',
  response: frameworkListSchema,
});
documentRoute({
  method: 'get',
  path: '/frameworks/{id}',
  summary: 'One framework with its counts for the caller; 404 when missing or hidden',
  response: frameworkSummarySchema,
});
documentRoute({
  method: 'get',
  path: '/frameworks/{id}/requirements',
  summary:
    "A framework's requirements, paged in natural code order, with group, coverage, status and search filters; each row carries its coverage for the caller",
  response: pagedRequirementsSchema,
  query: requirementListQuerySchema,
});
documentRoute({
  method: 'get',
  path: '/requirements/{id}',
  summary: 'One requirement, the controls that satisfy it, and its links to other frameworks in both directions',
  response: requirementDetailSchema,
});
documentRoute({
  method: 'get',
  path: '/controls/{id}/requirements',
  summary: 'The requirements a control satisfies, in framework then natural code order',
  response: controlRequirementListSchema,
});
