// The decision routes (S5-003; D24, D38, D47, D50), under /api/v1:
//   POST /review/findings/:id/approve   review_queue work   S5-001's approve body for the finding's
//                                                            kind -> the decision; 400, 403, 404, 409
//   POST /review/findings/:id/reject    review_queue work   { note? } -> the decision; 403, 404, 409
// The guard lets only the Review-queue `work` cell through (the Analyst): the Admin, who only views
// the queue, and every other role get 403 before anything runs, and the service checks again (and
// refuses API keys: a decision is a person's judgement). A finding that is missing, another org's
// or above the caller's clearance is 404. The org, role and clearance always come from
// `request.principal`. Decorators are applied as plain calls, so the code runs without decorator
// syntax support.
import { Body, Controller, HttpCode, Inject, Param, Post, Req, UseGuards } from '@nestjs/common';
import { approveBodySchema, rejectBodySchema } from '@grc/shared';
import { AccessGuard } from '../../access/access.guard.js';
import { Requires } from '../../access/requires.decorator.js';
import { documentRoute } from '../../common/openapi.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import { callerOf } from '../../intake/imports/imports.controller.js';
import { ReviewDecideService, reviewDecisionSchema, type ReviewDecision } from './decide.service.js';

export class ReviewDecideController {
  constructor(private readonly decide: ReviewDecideService) {}

  approve(request: AuthedRequest, id: string, body: unknown): Promise<ReviewDecision> {
    return this.decide.approve(callerOf(request), id, body ?? {});
  }

  reject(request: AuthedRequest, id: string, body: unknown): Promise<ReviewDecision> {
    return this.decide.reject(callerOf(request), id, body ?? {});
  }
}
{
  const p = ReviewDecideController.prototype;
  const d = (method: keyof ReviewDecideController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Post(':id/approve')(p, 'approve', d('approve'));
  HttpCode(200)(p, 'approve', d('approve'));
  Req()(p, 'approve', 0);
  Param('id')(p, 'approve', 1);
  Body()(p, 'approve', 2);

  Post(':id/reject')(p, 'reject', d('reject'));
  HttpCode(200)(p, 'reject', d('reject'));
  Req()(p, 'reject', 0);
  Param('id')(p, 'reject', 1);
  Body()(p, 'reject', 2);

  Requires('review_queue', 'work')(ReviewDecideController);
  UseGuards(AccessGuard)(ReviewDecideController);
  Controller('review/findings')(ReviewDecideController);
  Inject(ReviewDecideService)(ReviewDecideController, undefined, 0);
}

documentRoute({
  method: 'post',
  path: '/review/findings/{id}/approve',
  summary:
    "Approve a pending review finding (the Analyst only; 403 for an Admin, every other role and API keys). The body depends on the finding's kind: a link takes `from` and `to` for an end that wasn't a clear match (one of that end's candidates; 400 end_not_chosen or end_not_candidate), and waits for a proposed new record it points to (409 end_not_approved or end_rejected); a proposed record takes `record`, the create body of its kind, labelled no lower than its document (400 label_below_source) and no higher than your clearance; a possible duplicate takes `keep`, the record to keep (by default the older one), and the kept record takes the higher of the two labels; a suggested mapping needs the Framework-mappings approve cell. Every kind takes an optional `note`. The graph change and its audit entries are written in one Neo4j transaction as origin `ai`, never doubled (outcome `exists` when the link is already there), then the finding becomes approved with its outcome and a review.approved entry. 404 when the finding or a record it names is missing or hidden; 409 already_decided when it isn't pending (the loser of two decisions at once), record_not_active when a record is retired or merged away, source_above_ends when the document is more sensitive than the link's ends allow (it can only be rejected); 400 link_not_allowed when the link doesn't fit the ontology",
  body: approveBodySchema,
  response: reviewDecisionSchema,
});
documentRoute({
  method: 'post',
  path: '/review/findings/{id}/reject',
  summary:
    "Reject a pending review finding of any kind (the Analyst only; 403 for an Admin, every other role and API keys): it becomes rejected with you as decider, the time and the optional note, and a review.rejected entry; it is hidden from the default view, kept forever and never raised again. Nothing changes in the graph. Rejecting a proposed new record also rejects every pending link finding pointing to it that you can see, each with its own entry (listed in rejectedLinkFindingIds). 404 when the finding is missing or hidden; 409 already_decided when it isn't pending",
  body: rejectBodySchema,
  response: reviewDecisionSchema,
});
