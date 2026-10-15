// The upload route (S3-004, D47, D53, D64), under /api/v1 with the `uploads` cell (Admin, Risk
// Manager, Compliance Manager and Analyst; the Control Owner, Auditor and Viewer get 403 at the
// guard, before any of the body is read):
//   POST /uploads   multipart: one file, plus kind, label (optional) and source (asset lists only)
//     201 { document, duplicate: false, jobId, importId? }   a new file, stored and queued
//     200 { document, duplicate: true }                      the org already has that content
//     400 validation_failed · 403 forbidden · 409 already_stored · 413 file_too_large
//     415 unsupported_file_type · 429 rate_limited (20 uploads a minute per person)
// The service then checks `canUpload(role, kind)` and the label against the caller's clearance.
// The org, role and clearance always come from `request.principal`.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Controller, Inject, Post, Req, Res, UseGuards } from '@nestjs/common';
import { LABELS, MAX_UPLOAD_BYTES, UPLOAD_KINDS, sourceNameSchema } from '@grc/shared';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AccessGuard } from '../../access/access.guard.js';
import { Requires } from '../../access/requires.decorator.js';
import { documentRoute } from '../../common/openapi.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import { callerOf } from '../imports/imports.controller.js';
import { readMultipartForm } from './multipart.js';
import { UploadsService, uploadCreatedSchema, uploadDuplicateSchema, type UploadAnswer } from './uploads.service.js';

export class UploadsController {
  constructor(private readonly uploads: UploadsService) {}

  async upload(request: FastifyRequest & AuthedRequest, reply: FastifyReply): Promise<UploadAnswer> {
    const caller = callerOf(request);
    const form = await readMultipartForm(request);
    const answer = await this.uploads.upload(caller, form);
    void reply.status(answer.duplicate ? 200 : 201);
    return answer;
  }
}
{
  const p = UploadsController.prototype;
  const d = (method: keyof UploadsController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Post()(p, 'upload', d('upload'));
  Req()(p, 'upload', 0);
  Res({ passthrough: true })(p, 'upload', 1);

  Requires('uploads', 'use')(UploadsController);
  UseGuards(AccessGuard)(UploadsController);
  Controller('uploads')(UploadsController);
  Inject(UploadsService)(UploadsController, undefined, 0);
}

documentRoute({
  method: 'post',
  path: '/uploads',
  summary:
    'Upload one file (PDF, DOCX, CSV, JSON or TXT, checked by content, at most 25 MB) as an asset list, policy document, SOC ticket file or audit report. Stored once per org by content: 201 with the new document and its job (and import, for an asset list); 200 with the existing document when the org already has that content. Audited as document.uploaded. 20 uploads a minute per person',
  multipart: {
    fields: z.object({
      kind: z.enum(UPLOAD_KINDS).describe('What the file is'),
      label: z.enum(LABELS).optional().describe('The sensitivity label, internal when not given; never above yours'),
      source: sourceNameSchema
        .optional()
        .describe('The source system, required for an asset list and refused otherwise'),
    }),
    files: { file: `The file, at most ${MAX_UPLOAD_BYTES} bytes` },
  },
  response: uploadDuplicateSchema,
  responses: { '201': { description: 'Created', schema: uploadCreatedSchema } },
});
