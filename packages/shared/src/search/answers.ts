// The search answer (D30, D46, D47; S6 shared notes, "One question, step by step"), shared by
// `POST /api/v1/search` (S6-005), the chat (S6-006) and the benchmark (S8): the mode, the fused
// results best first, the graph part and the timings.
// - A result is a passage (Path A) or a graph record (Path B), with its fused rank and RRF score,
//   the paths that found it, and whether it went into the context Gemma reads.
// - Results hold only what the asker may see: the API checks every one with the asker's own access
//   (D23, D45.3) before it is listed, and anything hidden is left out, never shown as hidden.
// - Times are in milliseconds.
import { z } from 'zod';
import { LABELS } from '../access/labels.js';
import { DOCUMENT_KINDS } from '../intake/uploads.js';
import { searchModeSchema } from './bodies.js';
import { GRAPH_FALLBACK_REASONS } from './fallback.js';
import { SEARCH_RECORD_KINDS } from './kinds.js';
import { SEARCH_LIMITS } from './limits.js';
import { SEARCH_PATHS } from './modes.js';

/** A record's on-screen number, for example `RSK0001014` or `REQ0001001`. */
export const searchRecordNumberSchema = z.string().regex(/^[A-Z]{3}\d{7}$/);

const ms = z.number().min(0);
const label = z.enum(LABELS);

/** A record's key field value, as stored: plain text, a number, true/false, or empty. */
export const keyFieldValueSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);

/** A passage Path A found: one chunk of a document. */
export const searchPassageSchema = z.object({
  chunkId: z.uuid(),
  documentId: z.uuid(),
  documentName: z.string(),
  documentKind: z.enum(DOCUMENT_KINDS),
  /** The chunk's place in its document, from 0. */
  position: z.int().min(0),
  text: z.string(),
  label,
  /** 1 minus the cosine distance. */
  similarity: z.number().min(-1).max(1),
});

/** A record Path B found, with its kind's key fields (for example `impact` and `likelihood`). */
export const searchRecordSchema = z.object({
  id: z.uuid(),
  number: searchRecordNumberSchema,
  name: z.string(),
  kind: z.enum(SEARCH_RECORD_KINDS),
  label,
  keyFields: z.record(z.string(), keyFieldValueSchema),
});

const resultBase = {
  /** Its place in the fused order, from 1. */
  rank: z.int().min(1),
  /** Its RRF score. */
  score: z.number().min(0),
  /** The paths that found it. */
  foundBy: z.array(z.enum(SEARCH_PATHS)).min(1),
  /** Whether it went into the context Gemma reads. */
  inContext: z.boolean(),
};

export const passageResultSchema = z.object({
  ...resultBase,
  type: z.literal('passage'),
  passage: searchPassageSchema,
});
export const recordResultSchema = z.object({ ...resultBase, type: z.literal('record'), record: searchRecordSchema });

export const searchResultSchema = z.discriminatedUnion('type', [passageResultSchema, recordResultSchema]);

/** The graph path (Path B). In vector mode it never runs: `ran` false, no query, no fallback. */
export const searchGraphPartSchema = z.object({
  /** True when the query ran in the org's database and its rows were read. */
  ran: z.boolean(),
  /** The query, when Gemma wrote one (also when it was then refused or failed). */
  query: z.string().nullable(),
  /** Why the graph path gave nothing, when it failed. */
  fallback: z.enum(GRAPH_FALLBACK_REASONS).nullable(),
  /** The rows read, at most 50. */
  rowsRead: z.int().min(0).max(SEARCH_LIMITS.graphRows),
});

export const searchTimingsSchema = z.object({
  /** Embedding the question (bge-m3). */
  embeddingMs: ms,
  /** Path A's vector search. */
  vectorSearchMs: ms,
  /** Gemma writing the graph query; null when it wasn't asked (vector mode). */
  queryWritingMs: ms.nullable(),
  /** Running the graph query; null when it didn't run. */
  queryRunningMs: ms.nullable(),
  /** Fusion, the entity filter and the context. */
  fusionMs: ms,
});

export const searchAnswerSchema = z.object({
  mode: searchModeSchema,
  /** Best first, at most 50. */
  results: z.array(searchResultSchema).max(SEARCH_LIMITS.searchResults),
  graph: searchGraphPartSchema,
  timings: searchTimingsSchema,
});

export type KeyFieldValue = z.infer<typeof keyFieldValueSchema>;
export type SearchPassage = z.infer<typeof searchPassageSchema>;
export type SearchRecord = z.infer<typeof searchRecordSchema>;
export type PassageResult = z.infer<typeof passageResultSchema>;
export type RecordResult = z.infer<typeof recordResultSchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SearchGraphPart = z.infer<typeof searchGraphPartSchema>;
export type SearchTimings = z.infer<typeof searchTimingsSchema>;
export type SearchAnswer = z.infer<typeof searchAnswerSchema>;
