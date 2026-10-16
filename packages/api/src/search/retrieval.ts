// The retrieval interfaces (S6-001; D23, D45.2, D45.3, D45.7, D46, D51, SF-049), one per search part,
// each behind its token, so the parts that use another build against its interface and never wait
// for it (S6 shared notes, "The search module"). Types and tokens only.
//
// - VECTOR_SEARCH (vector/, S6-003): Path A. The question's vector, then the closest passages the
//   caller may see (row security on chunks, checked again in the API), never a removed document's
//   or a chunk without a vector. Rejects with an `AiFailure` when bge-m3 can't be reached; the caller
//   answers `assistant_unavailable`.
// - GRAPH_SEARCH (graph/, S6-004): Path B. The model writes one read-only query, our code checks it,
//   and it runs in the caller's org database as their role x clearance account, stopped after 5 s.
//   It never rejects: every failure is a fallback reason, and the answer uses documents only.
// - RETRIEVAL (hybrid/, S6-005): both paths (or Path A only, in vector mode), RRF with k=60, the
//   entity filter, and the context for Gemma. Rejects with an `AiFailure` when bge-m3 can't be
//   reached.
// Everything these return is already limited to what the caller may see (D23): nothing hidden ever
// reaches Gemma or the answer. Times are in milliseconds.
import type {
  AnswerSource,
  GraphFallbackReason,
  KeyFieldValue,
  Label,
  RecordOrigin,
  RecordStatus,
  RecordType,
  Role,
  SearchGraphPart,
  SearchLinkType,
  SearchMode,
  SearchPassage,
  SearchRecord,
  SearchResult,
  SearchTimings,
} from '@grc/shared';
import type { TextModel } from '../ai/text-model.js';

export const VECTOR_SEARCH = Symbol('VectorSearch');
export const GRAPH_SEARCH = Symbol('GraphSearch');
export const RETRIEVAL = Symbol('Retrieval');

/** Who is searching or asking: their org, principal user ID, role and clearance (D50, D51). */
export interface SearchCaller {
  orgId: string;
  /** The principal user ID: a person's user ID, or `api_key:<id>` for a machine key. */
  userId: string;
  role: Role;
  clearance: Label;
  /** A signed-in person, or a machine API key. */
  kind: 'person' | 'api_key';
}

/** Anything with the text model's `generate`: a Gemma turn's session (S6-002) or the text model. */
export type GraphQueryModel = Pick<TextModel, 'generate'>;

// ---- Path A ------------------------------------------------------------------------------------

/** A passage Path A found, with the chunk's record type (its document's) and the records it names
 * (the visible `chunk_records` rows). */
export interface VectorPassage extends SearchPassage {
  recordType: RecordType;
  recordIds: readonly string[];
}

export interface VectorSearchResult {
  /** Closest first, at most 20. */
  passages: VectorPassage[];
  timings: { embeddingMs: number; searchMs: number };
}

export interface VectorSearch {
  search(caller: SearchCaller, question: string): Promise<VectorSearchResult>;
}

// ---- Path B ------------------------------------------------------------------------------------

/** A record Path B found: the search record, plus its status. */
export interface GraphRecord extends SearchRecord {
  status: RecordStatus;
}

/** Where an AI link came from: only for a caller cleared for the link's source label (SF-049). */
export interface GraphLinkSource {
  documentId: string;
  chunkId: string;
  sentence: string;
}

/** A link between two records Path B found; both ends are among its records. */
export interface GraphLink {
  type: SearchLinkType;
  /** The record IDs of its two ends. */
  from: string;
  to: string;
  origin: RecordOrigin;
  /** Null for a link not made by the AI, and for a caller not cleared for its source. */
  source: GraphLinkSource | null;
}

/** A plain value the query returned (a count, a name, a date): never a node or a link. */
export type GraphPlainValue = KeyFieldValue | readonly KeyFieldValue[];

/** One row's plain values by column name (rows with none are left out). */
export type GraphValueRow = Readonly<Record<string, GraphPlainValue>>;

export interface GraphSearchTimings {
  /** The model writing the query. */
  writingMs: number;
  /** Running it; null when it didn't run. */
  runningMs: number | null;
}

export interface GraphSearchOk {
  ok: true;
  query: string;
  /** In the order they first appear in the rows. */
  records: GraphRecord[];
  links: GraphLink[];
  values: GraphValueRow[];
  /** At most 50. */
  rowsRead: number;
  timings: GraphSearchTimings;
}

export interface GraphSearchFailed {
  ok: false;
  fallback: GraphFallbackReason;
  /** The query, when the model wrote one. */
  query: string | null;
  timings: GraphSearchTimings;
}

export type GraphSearchResult = GraphSearchOk | GraphSearchFailed;

export interface GraphSearch {
  search(caller: SearchCaller, question: string, model: GraphQueryModel): Promise<GraphSearchResult>;
}

// ---- Fusion ------------------------------------------------------------------------------------

export interface RetrieveOptions {
  mode: SearchMode;
  /** The model that writes the graph query (hybrid only); the text model itself when not given. */
  model?: GraphQueryModel;
}

/** The two context sections, each its full text with its markers, ready for the prompt's data. */
export interface RetrievalContext {
  /** `<GRAPH_CONTEXT>`: the kept records, the links among them and the query's plain values; empty
   * of records in vector mode or when the graph path failed. */
  graph: string;
  /** `<UNSTRUCTURED_DOCUMENT_CONTEXT>`: the kept passages, section markers inside them neutralised. */
  documents: string;
}

export interface RetrievalResult {
  mode: SearchMode;
  /** The fused results after the visibility checks, best first, each marked if it is in the context. */
  results: SearchResult[];
  /** What the answer may cite: the kept records and passages, numbered from 1 in fused order. */
  sources: AnswerSource[];
  context: RetrievalContext;
  /** Whether the graph query ran, the query if any, the fallback reason if any, and the rows read. */
  graph: SearchGraphPart;
  /** The highest label among the sources; Public when there are none. */
  label: Label;
  timings: SearchTimings;
}

export interface Retrieval {
  retrieve(caller: SearchCaller, question: string, options: RetrieveOptions): Promise<RetrievalResult>;
}
