// The document routes (S3-005, D47, D53), all under /api/v1 and all with the `uploads` cell
// (Admin, Risk Manager, Compliance Manager and Analyst; the Control Owner, Auditor and Viewer get
// 403 at the guard):
//   GET /documents                 the list query -> Paged<DocumentOut>
//   GET /documents/:id             -> the DocumentOut (plus importId for an asset list); 404 when hidden
//   GET /documents/:id/download    -> the stored bytes, audited `document.downloaded`; 404 when hidden
// The service checks the role's view cell for the document's record type and the label, and RLS
// checks both again. The org, role and clearance always come from `request.principal`.
// Decorators are applied as plain calls, so the code runs without decorator syntax support.
import { Controller, Get, Header, Inject, Param, Query, Req, StreamableFile, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { AccessGuard } from '../../access/access.guard.js';
import { Requires } from '../../access/requires.decorator.js';
import { ApiError } from '../../common/errors.js';
import { documentRoute } from '../../common/openapi.js';
import type { Paged } from '../../common/paging.js';
import type { AuthedRequest } from '../../identity/session.guard.js';
import type { Caller } from '../../records/records.service.js';
import {
  DocumentsService,
  documentDetailSchema,
  documentListQuerySchema,
  pagedDocumentsSchema,
  type DocumentDetail,
  type DocumentOut,
} from './documents.service.js';

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

export class DocumentsController {
  constructor(private readonly documents: DocumentsService) {}

  list(request: AuthedRequest, query: unknown): Promise<Paged<DocumentOut>> {
    return this.documents.list(callerOf(request), query ?? {});
  }

  get(request: AuthedRequest, id: string): Promise<DocumentDetail> {
    return this.documents.get(callerOf(request), id);
  }

  async download(request: AuthedRequest, id: string): Promise<StreamableFile> {
    const file = await this.documents.download(callerOf(request), id);
    return new StreamableFile(file.body, {
      type: file.contentType,
      disposition: file.disposition,
      length: file.body.length,
    });
  }
}
{
  const p = DocumentsController.prototype;
  const d = (method: keyof DocumentsController): PropertyDescriptor => Object.getOwnPropertyDescriptor(p, method)!;

  Get()(p, 'list', d('list'));
  Req()(p, 'list', 0);
  Query()(p, 'list', 1);

  Get(':id')(p, 'get', d('get'));
  Req()(p, 'get', 0);
  Param('id')(p, 'get', 1);

  Get(':id/download')(p, 'download', d('download'));
  Header('X-Content-Type-Options', 'nosniff')(p, 'download', d('download'));
  Req()(p, 'download', 0);
  Param('id')(p, 'download', 1);

  Requires('uploads', 'use')(DocumentsController);
  UseGuards(AccessGuard)(DocumentsController);
  Controller('documents')(DocumentsController);
  Inject(DocumentsService)(DocumentsController, undefined, 0);
}

documentRoute({
  method: 'get',
  path: '/documents',
  summary:
    'List the stored documents the caller can see, paged, with kind, status, source, label and file-name search; sorted by -createdAt (default), createdAt or fileName',
  response: pagedDocumentsSchema,
  query: documentListQuerySchema,
});
documentRoute({
  method: 'get',
  path: '/documents/{id}',
  summary: 'Open one stored document (with its import for an asset list); 404 when missing or hidden',
  response: documentDetailSchema,
});
documentRoute({
  method: 'get',
  path: '/documents/{id}/download',
  summary:
    'Download the stored file as an attachment (Content-Type from its format); every download is audited as document.downloaded. 404 when missing or hidden',
  response: z.string().describe('The stored file, byte for byte'),
});
