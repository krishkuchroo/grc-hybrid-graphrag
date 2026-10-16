// Why a document failed (S4 shared notes, "Document status"): the short code kept in
// `documents.failure_code`, empty unless the document's status is `failed`. The same list as
// S4-001's codes in @grc/shared, and as the `documents_failure_code_check` constraint the processing
// migration adds. No imports, so the intake schema can use it without importing the processing one.

/** The codes a document fails with: unreadable file, no text, a sandbox limit, or a step's last try used up. */
export const DOCUMENT_FAILURE_CODES = [
  'unreadable',
  'no_text',
  'timed_out',
  'too_much_memory',
  'read_failed',
  'embed_failed',
  'extract_failed',
  'resolve_failed',
] as const;

export type DocumentFailureCode = (typeof DOCUMENT_FAILURE_CODES)[number];
