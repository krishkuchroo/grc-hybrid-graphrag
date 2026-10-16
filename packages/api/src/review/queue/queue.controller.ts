// The review queue's read routes (S5-002; D47, D50, D51), all under /api/v1 and all with the
// Review-queue `view` cell (Admin and Analyst; every other role gets 403 at the guard):
//   GET /review/findings        S5-001's list query -> PagedReviewFindings (pending, newest first)
//   GET /review/findings/:id    -> ReviewFindingDetail; 404 when hidden, missing or another org's
//   GET /review/counts          -> ReviewCounts: pending findings per kind, and their total
// The service checks the cell again, and every read runs in the reader's own view (./queue.service.ts).
// The org, role and clearance always come from `request.principal`.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import {
  pagedReviewFindingsSchema,
  reviewCountsSchema,
  reviewFindingDetailSchema,
  reviewListQuerySchema,
  type PagedReviewFindings,
  type ReviewCounts,
  type ReviewFindingDetail,
} from '@grc/shared';
import { Controller, Get, Inject, Param, Query, Req, UseGuards } from '@nestjs/common';
import { AccessGuard } from '../../access/access.guard.js';
import { Requires } from '../../access/requires.decorator.js';
import { ApiError } from '../../common/errors.js';
import { documentRoute } from '../../common/openapi.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import type { Caller } from '../../records/records.service.js';
import { ReviewQueueService } from './queue.service.js';

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

export class ReviewQueueController {
  constructor(private readonly queue: ReviewQueueService) {}

  list(request: AuthedRequest, query: unknown): Promise<PagedReviewFindings> {
    return this.queue.list(callerOf(request), query ?? {});
  }

  get(request: AuthedRequest, id: string): Promise<ReviewFindingDetail> {
    return this.queue.get(callerOf(request), id);
  }

  counts(request: AuthedRequest): Promise<ReviewCounts> {
    return this.queue.counts(callerOf(request));
  }
}
{
  const p = ReviewQueueController.prototype;
  const d = (method: keyof ReviewQueueController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Get('findings')(p, 'list', d('list'));
  Req()(p, 'list', 0);
  Query()(p, 'list', 1);

  Get('findings/:id')(p, 'get', d('get'));
  Req()(p, 'get', 0);
  Param('id')(p, 'get', 1);

  Get('counts')(p, 'counts', d('counts'));
  Req()(p, 'counts', 0);

  Requires('review_queue', 'view')(ReviewQueueController);
  UseGuards(AccessGuard)(ReviewQueueController);
  Controller('review')(ReviewQueueController);
  Inject(ReviewQueueService)(ReviewQueueController, undefined, 0);
}

documentRoute({
  method: 'get',
  path: '/review/findings',
  summary:
    "The Analyst review queue (Admins and Analysts): the AI findings in the caller's view, paged; pending and newest first by default. Filters: kind, status (one or more, comma-separated), documentId, recordId (any record a finding names) and failedCheck; sort newest or oldest. A record the caller can't see now shows as `{ hidden: true }`; findings above the caller's clearance are never listed",
  response: pagedReviewFindingsSchema,
  query: reviewListQuerySchema,
});
documentRoute({
  method: 'get',
  path: '/review/findings/{id}',
  summary:
    'One review finding in full: its source document, the sentence inside its chunk text, failed checks, each end with its match or candidates, the details of its kind, and the decision and its outcome. 404 when missing, hidden or another org’s',
  response: reviewFindingDetailSchema,
});
documentRoute({
  method: 'get',
  path: '/review/counts',
  summary: "The pending review findings per kind, and their total, in the caller's view",
  response: reviewCountsSchema,
});
