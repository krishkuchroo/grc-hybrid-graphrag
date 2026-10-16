// The removal routes (S5-004; D38, D47, D50, D52.5, D207), under /api/v1:
//   POST /review/findings/:id/remove   { note? } -> 200 FindingRemoved
//     Review-queue `work` (the Analyst); 403 for every other role, the Admin included
//     404 when hidden, missing or another org's (the finding, or a record it names)
//     409 not_removable (a duplicate, a pending finding) · 409 already_decided (rejected, removed)
//   GET  /review/documents/:id                   -> 200 ReviewDocumentImpact
//     Review-queue `view` (Admin and Analyst); 403 for every other role
//     404 when the reader may not see the document, or it's another org's
//   POST /review/documents/:id/remove  { note? } -> 200 DocumentRemoved (counts only)
//     Review-queue `work` (the Analyst); 403 for every other role, the Admin included
//     404 as for the impact · 409 not_removable for an asset list
// The guard checks the D50 cell first; the service checks it again with the org, label and record
// rules. The org, role and clearance always come from `request.principal`.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import {
  documentRemoveBodySchema,
  removeBodySchema,
  reviewDocumentImpactSchema,
  type ReviewDocumentImpact,
} from '@grc/shared';
import { AccessGuard } from '../../access/access.guard.js';
import { Requires } from '../../access/requires.decorator.js';
import { ApiError } from '../../common/errors.js';
import { documentRoute } from '../../common/openapi.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import type { Caller } from '../../records/records.service.js';
import {
  ReviewRemoveService,
  documentRemovedSchema,
  findingRemovedSchema,
  type DocumentRemoved,
  type FindingRemoved,
} from './remove.service.js';

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

export class ReviewRemoveController {
  constructor(private readonly removals: ReviewRemoveService) {}

  removeFinding(request: AuthedRequest, id: string, body: unknown): Promise<FindingRemoved> {
    return this.removals.removeFinding(callerOf(request), id, body);
  }

  documentImpact(request: AuthedRequest, id: string): Promise<ReviewDocumentImpact> {
    return this.removals.documentImpact(callerOf(request), id);
  }

  removeDocument(request: AuthedRequest, id: string, body: unknown): Promise<DocumentRemoved> {
    return this.removals.removeDocument(callerOf(request), id, body);
  }
}
{
  const p = ReviewRemoveController.prototype;
  const d = (method: keyof ReviewRemoveController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Post('findings/:id/remove')(p, 'removeFinding', d('removeFinding'));
  HttpCode(200)(p, 'removeFinding', d('removeFinding'));
  Requires('review_queue', 'work')(p, 'removeFinding', d('removeFinding'));
  Req()(p, 'removeFinding', 0);
  Param('id')(p, 'removeFinding', 1);
  Body()(p, 'removeFinding', 2);

  Get('documents/:id')(p, 'documentImpact', d('documentImpact'));
  Requires('review_queue', 'view')(p, 'documentImpact', d('documentImpact'));
  Req()(p, 'documentImpact', 0);
  Param('id')(p, 'documentImpact', 1);

  Post('documents/:id/remove')(p, 'removeDocument', d('removeDocument'));
  HttpCode(200)(p, 'removeDocument', d('removeDocument'));
  Requires('review_queue', 'work')(p, 'removeDocument', d('removeDocument'));
  Req()(p, 'removeDocument', 0);
  Param('id')(p, 'removeDocument', 1);
  Body()(p, 'removeDocument', 2);

  UseGuards(AccessGuard)(ReviewRemoveController);
  Controller('review')(ReviewRemoveController);
  Inject(ReviewRemoveService)(ReviewRemoveController, undefined, 0);
}

documentRoute({
  method: 'post',
  path: '/review/findings/{id}/remove',
  summary:
    "Remove a live or approved AI finding that turned out false (Analysts only): a link or mapping's own AI link is deleted from the graph with a `link.removed` copy (a link that was already there from a person, an import or elsewhere is never deleted), or the record an approved new-record finding created is retired. The finding becomes `removed`, with your note, its outcome's `removed.graph` and a `review.removed` audit entry, and the AI never proposes it again. 404 when the finding or a record it names is hidden from you or missing; 409 `not_removable` for a duplicate or a pending finding (reject it instead); 409 `already_decided` once it is rejected or removed; 403 for every other role, Admins included",
  body: removeBodySchema,
  response: findingRemovedSchema,
});
documentRoute({
  method: 'get',
  path: '/review/documents/{id}',
  summary:
    'What removing one upload would touch (Admins and Analysts): the document, and counts of the live AI links from it in the graph, the records approved from its findings, its pending findings, and its live or approved findings. Counts include what is above your clearance, never by name or number. 404 when you may not see the document; 403 for every other role',
  response: reviewDocumentImpactSchema,
});
documentRoute({
  method: 'post',
  path: '/review/documents/{id}/remove',
  summary:
    'Remove everything from one bad upload in a single action (Analysts only): the document becomes Removed and is never processed again, every AI link from it is deleted from the graph (each with a `link.removed` entry), the records approved from its findings are retired, its pending findings are rejected and its live and approved ones removed, its chunk-to-record rows are dropped, and one `document.removed` entry holds the counts and your note. The stored file is kept. Answers what this run did, as counts only; running it again answers zero counts. 404 when you may not see the document; 409 `not_removable` for an asset list; 403 for every other role, Admins included',
  body: documentRemoveBodySchema,
  response: documentRemovedSchema,
});
