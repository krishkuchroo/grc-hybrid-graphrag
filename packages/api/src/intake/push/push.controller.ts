// The push API routes (S3-008, D47, D54, D59, D64), under /api/v1 with the `uploads` cell (Admin,
// Risk Manager, Compliance Manager and Analyst; the Control Owner, Auditor and Viewer get 403 at the
// guard):
//   POST /push/batches   { batchId, source, rows }   API keys only
//     202 { batchId, importId, jobId, duplicate: false }   a new batch, stored and queued for import
//     200 { batchId, importId, jobId, duplicate: true }    a batch (or rows) the org already had
//     400 validation_failed · 403 api_key_required / forbidden · 409 mapping_required
//     413 payload_too_large (1 MB) · 429 rate_limited (60 batches a minute per key)
//   GET /push/batches    paging, source, batchId; newest first   -> Paged<PushBatchOut>
// A signed-in person gets 403 `api_key_required` on the push before any other check
// (`ApiKeyOnlyGuard` runs before the access guard). The service then checks `canImportAssets` for
// the key's one role. The org, role and clearance always come from `request.principal`.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import {
  Body,
  Controller,
  Get,
  Inject,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { pushBatchSchema } from '@grc/shared';
import type { FastifyReply } from 'fastify';
import { AccessGuard } from '../../access/access.guard.js';
import { Requires } from '../../access/requires.decorator.js';
import { ApiError } from '../../common/errors.js';
import { documentRoute } from '../../common/openapi.js';
import type { Paged } from '../../common/paging.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import { callerOf } from '../imports/imports.controller.js';
import {
  PushService,
  pagedPushBatchesSchema,
  pushAnswerSchema,
  pushListQuerySchema,
  type PushAnswer,
  type PushBatchOut,
} from './push.service.js';

/** Lets only API keys through (403 `api_key_required` for a signed-in person, D54). */
export class ApiKeyOnlyGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<AuthedRequest>();
    if (request.principal?.apiKeyId === undefined) {
      throw new ApiError(403, 'api_key_required', 'Only an API key can push batches. Ask an Admin for one.');
    }
    return true;
  }
}

export class PushController {
  constructor(private readonly pushes: PushService) {}

  async push(request: AuthedRequest, body: unknown, reply: FastifyReply): Promise<PushAnswer> {
    const result = await this.pushes.push(callerOf(request), body ?? {});
    void reply.status(result.status);
    return result.answer;
  }

  list(request: AuthedRequest, query: unknown): Promise<Paged<PushBatchOut>> {
    return this.pushes.list(callerOf(request), query ?? {});
  }
}
{
  const p = PushController.prototype;
  const d = (method: keyof PushController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Post('batches')(p, 'push', d('push'));
  UseGuards(ApiKeyOnlyGuard, AccessGuard)(p, 'push', d('push'));
  Req()(p, 'push', 0);
  Body()(p, 'push', 1);
  Res({ passthrough: true })(p, 'push', 2);

  Get('batches')(p, 'list', d('list'));
  UseGuards(AccessGuard)(p, 'list', d('list'));
  Req()(p, 'list', 0);
  Query()(p, 'list', 1);

  Requires('uploads', 'use')(PushController);
  Controller('push')(PushController);
  Inject(PushService)(PushController, undefined, 0);
}

documentRoute({
  method: 'post',
  path: '/push/batches',
  summary:
    "Push a batch of asset rows (API keys only, at most 1 MB, 60 batches a minute per key; the key's role must be one that may import asset lists). The rows are stored as a JSON asset list and imported with the source's saved mapping (409 mapping_required without one): 202 with the batch, import and job IDs. The same source and batch ID again answers 200 with the first answer and duplicate: true, and nothing is stored or imported again; rows identical to an earlier batch's make no second document (200, duplicate: true). Audited as push.received",
  body: pushBatchSchema,
  response: pushAnswerSchema,
  responses: {
    '202': { description: 'Accepted: the batch is stored and its import queued', schema: pushAnswerSchema },
  },
});
documentRoute({
  method: 'get',
  path: '/push/batches',
  summary:
    "List the org's push batches the caller can see, newest first, paged, with source and batchId filters; each with its import's status and counts",
  response: pagedPushBatchesSchema,
  query: pushListQuerySchema,
});
