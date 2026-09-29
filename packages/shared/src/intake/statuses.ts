// Document and import statuses (S3 shared notes; S4 moves documents past `stored`).

export const DOCUMENT_STATUSES = ['stored', 'processing', 'processed', 'failed'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const IMPORT_STATUSES = ['reading', 'needs_mapping', 'queued', 'importing', 'done', 'failed'] as const;
export type ImportStatus = (typeof IMPORT_STATUSES)[number];
