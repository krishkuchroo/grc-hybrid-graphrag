// Which stored documents the reader turns into chunks (S4-004; D41, S3 shared notes "Upload kinds"):
// policy documents, SOC tickets and audit reports, in the formats those kinds accept. Asset lists go
// only through S3's column mapping (D40) and evidence files are not chunked (planner's reading R1),
// so neither gets a `processing.document-read` job. No imports of ours, so fast load can use it
// without loading the reader.

/** The document kinds the reader reads. */
export const READABLE_DOCUMENT_KINDS = ['policy_document', 'soc_ticket', 'audit_report'] as const;
export type ReadableDocumentKind = (typeof READABLE_DOCUMENT_KINDS)[number];

/** The formats the reader opens (CSV is an asset list's format only). */
export const READABLE_FORMATS = ['pdf', 'docx', 'txt', 'json'] as const;
export type ReadableFormat = (typeof READABLE_FORMATS)[number];

export function isReadableDocumentKind(v: unknown): v is ReadableDocumentKind {
  return typeof v === 'string' && (READABLE_DOCUMENT_KINDS as readonly string[]).includes(v);
}

export function isReadableFormat(v: unknown): v is ReadableFormat {
  return typeof v === 'string' && (READABLE_FORMATS as readonly string[]).includes(v);
}
