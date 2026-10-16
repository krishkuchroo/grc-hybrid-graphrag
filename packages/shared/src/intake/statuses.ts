// Document and import statuses (S3 shared notes; S4 moves documents past `stored`; S5 marks a whole
// upload taken back out `removed`, D52.5: it stays stored, and nothing is processed for it again).

export const DOCUMENT_STATUSES = ['stored', 'processing', 'processed', 'failed', 'removed'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const IMPORT_STATUSES = ['reading', 'needs_mapping', 'queued', 'importing', 'done', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
