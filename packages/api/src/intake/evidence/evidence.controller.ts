// The evidence routes (S3-009, D47, D50, D213 (3)), all under /api/v1:
//   GET   /evidence                   evidence view (own)   the list query -> Paged<evidence>
//   GET   /evidence/:id               evidence view (own)   -> the evidence; 404 when not visible
//   POST  /evidence                   evidence edit (own)   multipart: file + controlId, name,
//                                                           collectedDate, validUntil?, label?, owner?
//                                                           -> 201; 409 evidence_exists
//   PATCH /evidence/:id               evidence edit (own)   update schema + version; 409 stale_version
//   POST  /evidence/:id/retire        evidence edit (own)   { version } -> the evidence
//   POST  /evidence/:id/review        evidence view (own)   { decision, version } -> the evidence;
//                                                           403 for API keys and unless
//                                                           canReviewEvidence (S3-021, D220 (4))
//   GET   /evidence/:id/download      evidence view (own)   the file, audited document.downloaded
//   GET   /controls/:id/evidence      control view (own)    the evidence supporting a control
// "(own)": the Control Owner's `upload_own` cell passes the guard and the service applies the owner
// rule (D213 (3)): they add only to controls they own, see the evidence on their own controls, and
// change only evidence they added. Risk Managers, Compliance Managers, Auditors and Analysts get
// 403 on create, edit and retire. The routes that name an evidence item answer the Viewer (who
// never sees evidence, D50) with 404, the same as a missing item; its list and create are 403.
// POST /evidence counts toward the 20 uploads a minute per person (multipart.ts, upload-rate-limit.ts).
// The org, role and clearance always come from `request.principal`.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  StreamableFile,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { MAX_UPLOAD_BYTES, ROLE_TABLE, can, intakeUpdateSchemas, isRole } from '@grc/shared';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessGuard } from '../../access/access.guard.js';
import { REQUIRES_KEY, Requires, type Requirement } from '../../access/requires.decorator.js';
import { ApiError } from '../../common/errors.js';
import { documentRoute } from '../../common/openapi.js';
import type { Paged } from '../../common/paging.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import { callerOf } from '../imports/imports.controller.js';
import { readMultipartForm } from '../uploads/multipart.js';
import { controlEvidenceQuerySchema, evidenceListQuerySchema } from './evidence-queries.js';
import {
  EvidenceService,
  evidenceFormFieldsSchema,
  evidenceListSchema,
  evidenceOutSchema,
  pagedEvidenceSchema,
  retireEvidenceBodySchema,
  reviewEvidenceBodySchema,
  type EvidenceOut,
} from './evidence.service.js';

const REFUSED = 'You do not have permission to do this.';

/**
 * The D50 guard of the evidence routes. A role passes when the table lets it do the route's action
 * on evidence, and, on a route marked `{ own: true }`, the Control Owner's `upload_own` cell passes
 * too (`request.ownOnly`), for viewing and for adding or changing: the service then applies the
 * owner rule. Anyone else gets 403 in the one error format.
 */
export class EvidenceAccessGuard implements CanActivate {
  private readonly reflector = new Reflector();
  /** Whether a role that never sees evidence gets 404 instead of 403 (routes naming one item). */
  protected readonly hideFromNone: boolean = false;

  canActivate(context: ExecutionContext): boolean {
    const requirement = this.reflector.getAllAndOverride<Requirement | undefined>(REQUIRES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<AuthedRequest & { ownOnly?: boolean }>();
    const principal = request.principal;
    if (!requirement || !principal) throw new ForbiddenException(REFUSED);
    if (can(principal.role, requirement.subject, requirement.action)) return true;
    const role = principal.role;
    if (!isRole(role)) throw new ForbiddenException(REFUSED);
    const cell = ROLE_TABLE.evidence[role];
    if (
      requirement.own === true &&
      requirement.subject === 'evidence' &&
      cell === 'upload_own' &&
      (requirement.action === 'view' || requirement.action === 'edit')
    ) {
      request.ownOnly = true;
      return true;
    }
    if (this.hideFromNone && cell === 'none') throw new ApiError(404, 'not_found', 'The record was not found.');
    throw new ForbiddenException(REFUSED);
  }
}

/** The same guard for the routes that name one evidence item: the Viewer gets 404. */
export class EvidenceItemAccessGuard extends EvidenceAccessGuard {
  protected override readonly hideFromNone: boolean = true;
}

export class EvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  list(request: AuthedRequest, query: unknown): Promise<Paged<EvidenceOut>> {
    return this.evidence.list(callerOf(request), query ?? {});
  }

  get(request: AuthedRequest, id: string): Promise<EvidenceOut> {
    return this.evidence.get(callerOf(request), id);
  }

  async create(request: FastifyRequest & AuthedRequest): Promise<EvidenceOut> {
    const caller = callerOf(request);
    const form = await readMultipartForm(request);
    return this.evidence.create(caller, form);
  }

  update(request: AuthedRequest, id: string, body: unknown): Promise<EvidenceOut> {
    return this.evidence.update(callerOf(request), id, body ?? {});
  }

  retire(request: AuthedRequest, id: string, body: unknown): Promise<EvidenceOut> {
    const { version } = retireEvidenceBodySchema.parse(body ?? {});
    return this.evidence.retire(callerOf(request), id, version);
  }

  review(request: AuthedRequest, id: string, body: unknown): Promise<EvidenceOut> {
    return this.evidence.review(callerOf(request), id, body ?? {});
  }

  async download(request: AuthedRequest, id: string): Promise<StreamableFile> {
    const file = await this.evidence.download(callerOf(request), id);
    return new StreamableFile(file.body, {
      type: file.contentType,
      disposition: file.disposition,
      length: file.body.length,
    });
  }
}
{
  const p = EvidenceController.prototype;
  const d = (method: keyof EvidenceController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Get()(p, 'list', d('list'));
  Requires('evidence', 'view', { own: true })(p, 'list', d('list'));
  UseGuards(EvidenceAccessGuard)(p, 'list', d('list'));
  Req()(p, 'list', 0);
  Query()(p, 'list', 1);

  Get(':id')(p, 'get', d('get'));
  Requires('evidence', 'view', { own: true })(p, 'get', d('get'));
  UseGuards(EvidenceItemAccessGuard)(p, 'get', d('get'));
  Req()(p, 'get', 0);
  Param('id')(p, 'get', 1);

  Post()(p, 'create', d('create'));
  HttpCode(201)(p, 'create', d('create'));
  Requires('evidence', 'edit', { own: true })(p, 'create', d('create'));
  UseGuards(EvidenceAccessGuard)(p, 'create', d('create'));
  Req()(p, 'create', 0);

  Patch(':id')(p, 'update', d('update'));
  Requires('evidence', 'edit', { own: true })(p, 'update', d('update'));
  UseGuards(EvidenceItemAccessGuard)(p, 'update', d('update'));
  Req()(p, 'update', 0);
  Param('id')(p, 'update', 1);
  Body()(p, 'update', 2);

  Post(':id/retire')(p, 'retire', d('retire'));
  HttpCode(200)(p, 'retire', d('retire'));
  Requires('evidence', 'edit', { own: true })(p, 'retire', d('retire'));
  UseGuards(EvidenceItemAccessGuard)(p, 'retire', d('retire'));
  Req()(p, 'retire', 0);
  Param('id')(p, 'retire', 1);
  Body()(p, 'retire', 2);

  Post(':id/review')(p, 'review', d('review'));
  HttpCode(200)(p, 'review', d('review'));
  Requires('evidence', 'view', { own: true })(p, 'review', d('review'));
  UseGuards(EvidenceItemAccessGuard)(p, 'review', d('review'));
  Req()(p, 'review', 0);
  Param('id')(p, 'review', 1);
  Body()(p, 'review', 2);

  Get(':id/download')(p, 'download', d('download'));
  Header('X-Content-Type-Options', 'nosniff')(p, 'download', d('download'));
  Requires('evidence', 'view', { own: true })(p, 'download', d('download'));
  UseGuards(EvidenceItemAccessGuard)(p, 'download', d('download'));
  Req()(p, 'download', 0);
  Param('id')(p, 'download', 1);

  Controller('evidence')(EvidenceController);
  Inject(EvidenceService)(EvidenceController, undefined, 0);
}

/** GET /api/v1/controls/:id/evidence, with the control's `view` cell. The route carries the `own`
 * flag: a Control Owner passes the guard and the service limits them to their own controls (404
 * otherwise), as S1 does; a role that never views evidence gets 403 from the service. */
export class ControlEvidenceController {
  constructor(private readonly evidence: EvidenceService) {}

  list(request: AuthedRequest, id: string, query: unknown): Promise<{ items: EvidenceOut[] }> {
    return this.evidence.forControl(callerOf(request), id, query ?? {});
  }
}
{
  const p = ControlEvidenceController.prototype;
  Get(':id/evidence')(p, 'list', Object.getOwnPropertyDescriptor(p, 'list')!);
  Req()(p, 'list', 0);
  Param('id')(p, 'list', 1);
  Query()(p, 'list', 2);
  Requires('control', 'view', { own: true })(ControlEvidenceController);
  UseGuards(AccessGuard)(ControlEvidenceController);
  Controller('controls')(ControlEvidenceController);
  Inject(EvidenceService)(ControlEvidenceController, undefined, 0);
}

documentRoute({
  method: 'get',
  path: '/evidence',
  summary:
    'List evidence, paged, with control, label, status, review status, validity (valid, expiring, expired) and search; sorted by number, name, collectedDate or validUntil',
  response: pagedEvidenceSchema,
  query: evidenceListQuerySchema,
});
documentRoute({
  method: 'get',
  path: '/evidence/{id}',
  summary:
    'Open one evidence item with the controls it supports, its validity, review status and canEdit; 404 when missing or hidden',
  response: evidenceOutSchema,
});
documentRoute({
  method: 'post',
  path: '/evidence',
  summary:
    'Attach an evidence file (PDF, DOCX, CSV, JSON or TXT, checked by content, at most 25 MB) to a control. The file is stored once per org by content; the evidence (review status pending) and its SUPPORTS link are saved together and audited as record.created. 409 evidence_exists when the same file is already on that control. Counts toward the 20 uploads a minute per person',
  multipart: {
    fields: evidenceFormFieldsSchema,
    files: { file: `The evidence file, at most ${MAX_UPLOAD_BYTES} bytes` },
  },
  response: evidenceOutSchema,
  responses: { '201': { description: 'Created', schema: evidenceOutSchema } },
});
documentRoute({
  method: 'patch',
  path: '/evidence/{id}',
  summary:
    'Edit evidence (name, dates, label, owner); the review fields are refused (400), the date rules run on the merged evidence, and a stale version is refused (409 stale_version). An edit that changes accepted or rejected evidence sends it back to pending with no reviewer and no review time',
  body: intakeUpdateSchemas.evidence,
  response: evidenceOutSchema,
});
documentRoute({
  method: 'post',
  path: '/evidence/{id}/retire',
  summary: 'Retire evidence; it is kept with its link and file, never deleted',
  body: retireEvidenceBodySchema,
  response: evidenceOutSchema,
});
documentRoute({
  method: 'post',
  path: '/evidence/{id}/review',
  summary:
    'Accept or reject evidence: sets the review status, the caller as reviewer and the review time, versioned (409 stale_version) and audited as record.updated in one transaction. Only an Admin or a Compliance Manager who did not add the evidence (403 otherwise, and always for API keys); 404 when missing or hidden. Editing reviewed evidence later sends it back to pending',
  body: reviewEvidenceBodySchema,
  response: evidenceOutSchema,
});
documentRoute({
  method: 'get',
  path: '/evidence/{id}/download',
  summary:
    'Download the evidence file as an attachment (Content-Type from its format); every download is audited as document.downloaded. 404 when missing or hidden',
  response: z.string().describe('The stored file, byte for byte'),
});
documentRoute({
  method: 'get',
  path: '/controls/{id}/evidence',
  summary: 'The evidence supporting a control that the caller can see (active by default)',
  response: evidenceListSchema,
  query: controlEvidenceQuerySchema,
});
