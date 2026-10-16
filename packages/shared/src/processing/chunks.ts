// Chunks, vectors and document processing (D25, D42, D71; S4 shared notes, "Chunks", "Document
// status"): the window sizes, the vector size, a chunk's stages, the two processing modes and the
// short codes a failed document carries in `documents.failure_code`.

/** A chunk is a window of at most this many bge-m3 tokens (D71). */
export const CHUNK_MAX_TOKENS = 500;

/** Each chunk starts this many tokens before the previous one ended. */
export const CHUNK_OVERLAP_TOKENS = 50;

/** Every vector, for chunks and for record names, has exactly this many numbers (bge-m3, D25). */
export const EMBEDDING_DIMENSIONS = 1024;

/** Where a chunk is in the chain: read and stored, given its vector, read by Gemma, resolved. */
export const CHUNK_STAGES = ['read', 'embedded', 'extracted', 'resolved', 'failed'] as const;
export type ChunkStage = (typeof CHUNK_STAGES)[number];

export function isChunkStage(v: unknown): v is ChunkStage {
  return typeof v === 'string' && (CHUNK_STAGES as readonly string[]).includes(v);
}

/** `full` goes through Gemma; `embed_only` (fast-loaded documents, D42) gets only chunks, vectors
 * and mention links. */
export const PROCESSING_MODES = ['full', 'embed_only'] as const;
export type ProcessingMode = (typeof PROCESSING_MODES)[number];

export function isProcessingMode(v: unknown): v is ProcessingMode {
  return typeof v === 'string' && (PROCESSING_MODES as readonly string[]).includes(v);
}

/** Why a document ended `failed`. Ollama being down is never one of them (D45.7). */
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

export function isDocumentFailureCode(v: unknown): v is DocumentFailureCode {
  return typeof v === 'string' && (DOCUMENT_FAILURE_CODES as readonly string[]).includes(v);
}
