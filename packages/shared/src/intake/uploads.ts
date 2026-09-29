// The upload kinds, the record type and formats each carries, and the size limits (D40, D41, D53, D71;
// S3 shared notes, "Upload kinds").
import type { RecordType } from '../access/role-table.js';
import type { FileFormat } from './file-format.js';

/** What a person may upload through `POST /api/v1/uploads`. */
export const UPLOAD_KINDS = ['asset_list', 'policy_document', 'soc_ticket', 'audit_report'] as const;
export type UploadKind = (typeof UPLOAD_KINDS)[number];

/** Every kind a stored document can have; evidence arrives only through `POST /api/v1/evidence`. */
export const DOCUMENT_KINDS = [...UPLOAD_KINDS, 'evidence'] as const;
export type DocumentKind = (typeof DOCUMENT_KINDS)[number];

export function isUploadKind(v: unknown): v is UploadKind {
  return typeof v === 'string' && (UPLOAD_KINDS as readonly string[]).includes(v);
}

export function isDocumentKind(v: unknown): v is DocumentKind {
  return typeof v === 'string' && (DOCUMENT_KINDS as readonly string[]).includes(v);
}

/** The record type a document carries, so the role table and labels apply to it (D71). */
export const DOCUMENT_RECORD_TYPE: Readonly<Record<DocumentKind, RecordType>> = Object.freeze({
  asset_list: 'asset',
  policy_document: 'policy',
  soc_ticket: 'incident',
  audit_report: 'audit_finding',
  evidence: 'evidence',
});

/** The formats each kind accepts. */
export const KIND_FORMATS: Readonly<Record<DocumentKind, readonly FileFormat[]>> = Object.freeze({
  asset_list: ['csv', 'json'],
  policy_document: ['pdf', 'docx', 'txt'],
  soc_ticket: ['pdf', 'docx', 'txt', 'json'],
  audit_report: ['pdf', 'docx', 'txt', 'json'],
  evidence: ['pdf', 'docx', 'csv', 'json', 'txt'],
});

/** 25 MB per file (D53). */
export const MAX_UPLOAD_BYTES = 26_214_400;
export const MAX_FILE_NAME_LENGTH = 255;
