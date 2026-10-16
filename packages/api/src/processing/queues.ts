// The processing job queues (S4 shared notes, "The job chain"; D29, D72): each queue's name, its
// payload, how many of its jobs the worker runs at once, and its job key, as the sending and the
// handling tasks agree on them. `processing.document-read` is S3's `INTAKE_QUEUES.documentRead`,
// re-exported here.
//
// | queue                        | sent by                         | handled by | at once |
// | processing.document-read     | uploads (S3), fast load (S4-004) | S4-004     | 4       |
// | processing.document-embed    | S4-004                          | S4-005     | 2       |
// | processing.chunk-extract     | S4-005                          | S4-006     | 1 (Gemma) |
// | processing.chunk-resolve     | S4-005 (mentions), S4-006 (full) | S4-008     | 4       |
// | processing.record-dedupe     | S4-005                          | S4-007     | 4       |
// | processing.mapping-suggest   | S4-009's route                  | S4-009     | 1 (Gemma) |
//
// Every handler runs in the worker program only, under the intake system context
// (`INTAKE_SYSTEM_CONTEXT(orgId)`), writing as `PROCESSING_ACTOR_ID`; each is safe to run twice
// (D45.5). Retries are D72's (src/jobs/jobs.module.ts).
import type { Label, Role } from '@grc/shared';
import { INTAKE_QUEUES } from '../intake/queues.js';

export const PROCESSING_QUEUES = {
  documentRead: INTAKE_QUEUES.documentRead,
  documentEmbed: 'processing.document-embed',
  chunkExtract: 'processing.chunk-extract',
  chunkResolve: 'processing.chunk-resolve',
  recordDedupe: 'processing.record-dedupe',
  mappingSuggest: 'processing.mapping-suggest',
} as const;

export type ProcessingQueueKey = keyof typeof PROCESSING_QUEUES;
export type ProcessingQueue = (typeof PROCESSING_QUEUES)[ProcessingQueueKey];

/** How many jobs of each queue the worker runs at once (D72: read file ×4, embed ×2, Gemma ×1,
 * duplicate matching ×4). */
export const PROCESSING_CONCURRENCY: Readonly<Record<ProcessingQueueKey, number>> = Object.freeze({
  documentRead: 4,
  documentEmbed: 2,
  chunkExtract: 1,
  chunkResolve: 4,
  recordDedupe: 4,
  mappingSuggest: 1,
});

/** The actor every processing write is made as (audit entries, `createdBy` on AI links). */
export const PROCESSING_ACTOR_ID = 'system:processing';

/** How a chunk is resolved: `full` from Gemma's answer, `mentions` for embed-only documents (D42). */
export const CHUNK_RESOLVE_MODES = ['full', 'mentions'] as const;
export type ChunkResolveMode = (typeof CHUNK_RESOLVE_MODES)[number];

/** The kinds of mapping suggestion run (S4-009): `controls` (the starter's controls to one
 * framework's requirements) and `soc2_to_nist` (SOC 2 criteria to NIST 800-53 controls). */
export const MAPPING_SUGGEST_KINDS = ['controls', 'soc2_to_nist'] as const;
export type MappingSuggestKind = (typeof MAPPING_SUGGEST_KINDS)[number];

/** Each queue's payload. */
export interface DocumentReadJob {
  orgId: string;
  documentId: string;
}
export interface DocumentEmbedJob {
  orgId: string;
  documentId: string;
}
export interface ChunkExtractJob {
  orgId: string;
  chunkId: string;
}
export interface ChunkResolveJob {
  orgId: string;
  chunkId: string;
  mode: ChunkResolveMode;
}
export interface RecordDedupeJob {
  orgId: string;
  recordId: string;
}
export interface MappingSuggestJob {
  orgId: string;
  kind: MappingSuggestKind;
  /** The target framework's key, for a `controls` run. */
  framework?: string;
  /** The person who started the run: whose view the suggestions are made in. */
  startedBy: string;
  role: Role;
  clearance: Label;
}

/** Each queue's job key: a job with the same key already queued or running is not queued again. */
export const PROCESSING_JOB_KEYS = Object.freeze({
  documentRead: (orgId: string, contentHash: string): string => `${orgId}:${contentHash}`,
  documentEmbed: (documentId: string): string => documentId,
  chunkExtract: (chunkId: string): string => chunkId,
  chunkResolve: (chunkId: string): string => chunkId,
  recordDedupe: (recordId: string, embeddedName: string): string => `${recordId}:${embeddedName}`,
  mappingSuggest: (orgId: string, kind: MappingSuggestKind, framework?: string): string =>
    `${orgId}:${kind}:${framework ?? ''}`,
});
