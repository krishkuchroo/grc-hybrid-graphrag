// The audit finding routes (S3-010, D47), all under /api/v1:
//   GET   /audit-findings                        audit_finding view   the list query -> Paged<finding>
//   GET   /audit-findings/:id                    audit_finding view   -> the finding; 404 when not visible
//   POST  /audit-findings                        audit_finding edit   create schema + concernsId -> 201
//   PATCH /audit-findings/:id                    audit_finding edit   update schema + version; 409 stale_version
//   POST  /audit-findings/:id/retire             audit_finding edit   { version } -> the finding
//   GET   /audit-findings/:id/concerns           audit_finding view   the controls and risks it concerns
//   POST  /audit-findings/:id/concerns           audit_finding edit   { toId } -> 201 with the link
//   POST  /audit-findings/:id/concerns/remove    audit_finding edit   { toId } -> 200 with the removed link
//   GET   /controls/:id/audit-findings           control view (own)   the findings concerning a control
//   GET   /risks/:id/audit-findings              risk view            the findings concerning a risk
// The routes that name a finding answer a role that never sees findings (the Viewer, D50) with 404,
// the same as a missing finding, so nothing about a finding leaks; its list is 403 as for every
// type the role can never view. The org, role and clearance always come from `request.principal`.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { z } from 'zod';
import { ROLE_TABLE, auditFindingRecordSchema, intakeCreateSchemas, intakeUpdateSchemas, isRole } from '@grc/shared';
import { AccessGuard } from '../../access/access.guard.js';
import { Requires } from '../../access/requires.decorator.js';
import { ApiError } from '../../common/errors.js';
import { documentRoute } from '../../common/openapi.js';
import type { Paged } from '../../common/paging.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import type { Caller } from '../../records/records.service.js';
import { concernedFindingsQuerySchema, findingListQuerySchema, type ConcernKind } from './finding-queries.js';
import {
  FindingsService,
  concernBodySchema,
  concernLinkSchema,
  concernListSchema,
  findingListSchema,
  pagedFindingsSchema,
  removedConcernSchema,
  type ConcernItem,
  type ConcernLink,
  type RemovedConcern,
} from './findings.service.js';

/** The body of `POST /api/v1/audit-findings/:id/retire`. */
export const retireFindingBodySchema = z.strictObject({ version: z.int().min(1) });

type FindingRecord = z.infer<typeof auditFindingRecordSchema>;

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

/**
 * The D50 guard for the routes that name one finding. It is `AccessGuard` (same requirement, same
 * refusals), except that a role whose Audit-findings cell is `none` gets 404 `not_found` instead
 * of 403: for it every finding is hidden, so the answer is the same as for a missing one.
 */
export class FindingAccessGuard implements CanActivate {
  private readonly inner = new AccessGuard();

  canActivate(context: ExecutionContext): boolean {
    try {
      return this.inner.canActivate(context);
    } catch (err) {
      if (err instanceof ForbiddenException) {
        const role = context.switchToHttp().getRequest<AuthedRequest>().principal?.role;
        if (isRole(role) && ROLE_TABLE.audit_finding[role] === 'none') {
          throw new ApiError(404, 'not_found', 'The record was not found.');
        }
      }
      throw err;
    }
  }
}

export class AuditFindingsController {
  constructor(private readonly findings: FindingsService) {}

  list(request: AuthedRequest, query: unknown): Promise<Paged<FindingRecord>> {
    return this.findings.list(callerOf(request), query ?? {});
  }

  get(request: AuthedRequest, id: string): Promise<FindingRecord> {
    return this.findings.get(callerOf(request), id);
  }

  create(request: AuthedRequest, body: unknown): Promise<FindingRecord> {
    return this.findings.create(callerOf(request), body ?? {});
  }

  update(request: AuthedRequest, id: string, body: unknown): Promise<FindingRecord> {
    return this.findings.update(callerOf(request), id, body ?? {});
  }

  retire(request: AuthedRequest, id: string, body: unknown): Promise<FindingRecord> {
    const { version } = retireFindingBodySchema.parse(body ?? {});
    return this.findings.retire(callerOf(request), id, version);
  }

  concerns(request: AuthedRequest, id: string): Promise<{ items: ConcernItem[] }> {
    return this.findings.concerns(callerOf(request), id);
  }

  addConcern(request: AuthedRequest, id: string, body: unknown): Promise<ConcernLink> {
    return this.findings.addConcern(callerOf(request), id, body ?? {});
  }

  removeConcern(request: AuthedRequest, id: string, body: unknown): Promise<RemovedConcern> {
    return this.findings.removeConcern(callerOf(request), id, body ?? {});
  }
}
{
  const p = AuditFindingsController.prototype;
  const d = (method: keyof AuditFindingsController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Get()(p, 'list', d('list'));
  Requires('audit_finding', 'view')(p, 'list', d('list'));
  UseGuards(AccessGuard)(p, 'list', d('list'));
  Req()(p, 'list', 0);
  Query()(p, 'list', 1);

  Get(':id')(p, 'get', d('get'));
  Requires('audit_finding', 'view')(p, 'get', d('get'));
  UseGuards(FindingAccessGuard)(p, 'get', d('get'));
  Req()(p, 'get', 0);
  Param('id')(p, 'get', 1);

  Post()(p, 'create', d('create'));
  HttpCode(201)(p, 'create', d('create'));
  Requires('audit_finding', 'edit')(p, 'create', d('create'));
  UseGuards(AccessGuard)(p, 'create', d('create'));
  Req()(p, 'create', 0);
  Body()(p, 'create', 1);

  Patch(':id')(p, 'update', d('update'));
  Requires('audit_finding', 'edit')(p, 'update', d('update'));
  UseGuards(FindingAccessGuard)(p, 'update', d('update'));
  Req()(p, 'update', 0);
  Param('id')(p, 'update', 1);
  Body()(p, 'update', 2);

  Post(':id/retire')(p, 'retire', d('retire'));
  HttpCode(200)(p, 'retire', d('retire'));
  Requires('audit_finding', 'edit')(p, 'retire', d('retire'));
  UseGuards(FindingAccessGuard)(p, 'retire', d('retire'));
  Req()(p, 'retire', 0);
  Param('id')(p, 'retire', 1);
  Body()(p, 'retire', 2);

  Get(':id/concerns')(p, 'concerns', d('concerns'));
  Requires('audit_finding', 'view')(p, 'concerns', d('concerns'));
  UseGuards(FindingAccessGuard)(p, 'concerns', d('concerns'));
  Req()(p, 'concerns', 0);
  Param('id')(p, 'concerns', 1);

  Post(':id/concerns')(p, 'addConcern', d('addConcern'));
  HttpCode(201)(p, 'addConcern', d('addConcern'));
  Requires('audit_finding', 'edit')(p, 'addConcern', d('addConcern'));
  UseGuards(FindingAccessGuard)(p, 'addConcern', d('addConcern'));
  Req()(p, 'addConcern', 0);
  Param('id')(p, 'addConcern', 1);
  Body()(p, 'addConcern', 2);

  Post(':id/concerns/remove')(p, 'removeConcern', d('removeConcern'));
  HttpCode(200)(p, 'removeConcern', d('removeConcern'));
  Requires('audit_finding', 'edit')(p, 'removeConcern', d('removeConcern'));
  UseGuards(FindingAccessGuard)(p, 'removeConcern', d('removeConcern'));
  Req()(p, 'removeConcern', 0);
  Param('id')(p, 'removeConcern', 1);
  Body()(p, 'removeConcern', 2);

  Controller('audit-findings')(AuditFindingsController);
  Inject(FindingsService)(AuditFindingsController, undefined, 0);
}

interface ConcernedFindingsRoutes {
  list(request: AuthedRequest, id: string, query: unknown): Promise<{ items: FindingRecord[] }>;
}

/** GET /api/v1/<controls|risks>/:id/audit-findings, with that kind's `view` cell. The control
 * route carries the `own` flag: a Control Owner passes the guard and the service limits them to
 * their own controls (404 otherwise), as S1 does. */
function concernedFindingsController(
  kind: ConcernKind,
  path: string,
): new (findings: FindingsService) => ConcernedFindingsRoutes {
  const name = `${kind[0]!.toUpperCase()}${kind.slice(1)}AuditFindingsController`;
  const cls = {
    [name]: class implements ConcernedFindingsRoutes {
      constructor(readonly findings: FindingsService) {}

      list(request: AuthedRequest, id: string, query: unknown): Promise<{ items: FindingRecord[] }> {
        return this.findings.concerning(callerOf(request), kind, id, query ?? {});
      }
    },
  }[name]!;
  const p = cls.prototype;
  Get(':id/audit-findings')(p, 'list', Object.getOwnPropertyDescriptor(p, 'list')!);
  Req()(p, 'list', 0);
  Param('id')(p, 'list', 1);
  Query()(p, 'list', 2);
  Requires(kind, 'view', kind === 'control' ? { own: true } : undefined)(cls);
  UseGuards(AccessGuard)(cls);
  Controller(path)(cls);
  Inject(FindingsService)(cls, undefined, 0);
  return cls;
}

export const ControlAuditFindingsController = concernedFindingsController('control', 'controls');
export const RiskAuditFindingsController = concernedFindingsController('risk', 'risks');

documentRoute({
  method: 'get',
  path: '/audit-findings',
  summary: 'List audit findings, paged, with severity, status, owner, label, due (overdue, next_30_days) and search',
  response: pagedFindingsSchema,
  query: findingListQuerySchema,
});
documentRoute({
  method: 'get',
  path: '/audit-findings/{id}',
  summary: 'Open one audit finding; 404 when missing or hidden',
  response: auditFindingRecordSchema,
});
documentRoute({
  method: 'post',
  path: '/audit-findings',
  summary:
    'Record an audit finding with the control or risk it concerns (concernsId); the finding and its CONCERNS link are saved together',
  body: intakeCreateSchemas.audit_finding,
  response: auditFindingRecordSchema,
});
documentRoute({
  method: 'patch',
  path: '/audit-findings/{id}',
  summary:
    'Edit an audit finding; the date rules run on the merged finding, and a stale version is refused (409 stale_version)',
  body: intakeUpdateSchemas.audit_finding,
  response: auditFindingRecordSchema,
});
documentRoute({
  method: 'post',
  path: '/audit-findings/{id}/retire',
  summary: 'Retire an audit finding; it is kept, never deleted',
  body: retireFindingBodySchema,
  response: auditFindingRecordSchema,
});
documentRoute({
  method: 'get',
  path: '/audit-findings/{id}/concerns',
  summary: 'The controls and risks an audit finding concerns that the caller can see, with each link',
  response: concernListSchema,
});
documentRoute({
  method: 'post',
  path: '/audit-findings/{id}/concerns',
  summary:
    'Link an audit finding to another control or risk it concerns. Answers 404 not_found, 403 forbidden, or 409 link_exists',
  body: concernBodySchema,
  response: concernLinkSchema,
});
documentRoute({
  method: 'post',
  path: '/audit-findings/{id}/concerns/remove',
  summary:
    "Remove a CONCERNS link added by mistake. Answers 404 not_found, 403 forbidden, 409 ai_link_review_only for a link found by the AI (D207), or 409 last_concern for the finding's only link",
  body: concernBodySchema,
  response: removedConcernSchema,
});
documentRoute({
  method: 'get',
  path: '/controls/{id}/audit-findings',
  summary: 'The audit findings concerning a control that the caller can see (active by default)',
  response: findingListSchema,
  query: concernedFindingsQuerySchema,
});
documentRoute({
  method: 'get',
  path: '/risks/{id}/audit-findings',
  summary: 'The audit findings concerning a risk that the caller can see (active by default)',
  response: findingListSchema,
  query: concernedFindingsQuerySchema,
});
