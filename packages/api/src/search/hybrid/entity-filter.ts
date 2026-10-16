// The entity filter's visibility checks (S6-005; D23, D45.3, D50, D51; planner's reading S6-Q1):
// the API's own last check on what the two paths found, after Postgres row security (Path A) and the
// asker's role x clearance Neo4j account (Path B) have already filtered it. Anything that fails is
// dropped, never shown as hidden, so nothing the asker may not see reaches the results, the context
// or Gemma.
//
// - A passage is kept when it is well formed, the role views its record type and its document's,
//   both labels (the chunk's and its document's) are at or below the clearance, and its document is
//   one of the asker's own org's, visible to them and not `removed` (S5). The document facts come
//   from Postgres, read in the asker's org context (./retrieval.service.ts).
// - A record is kept when it is well formed, its kind is one a search can find, the role views that
//   kind's D50 row and its label is at or below the clearance. A record of an "own" cell (a Control
//   Owner's controls) is dropped: the graph account can't know who owns what, and neither does a
//   search record, so it fails safe (S1 shared notes, "One exception").
// - A link is kept when its type is a known link type and both its ends are among the kept records.
// Pure: no I/O.
import {
  DOCUMENT_RECORD_TYPE,
  SEARCH_RECORD_TYPE,
  isLabel,
  isRecordVisible,
  isSearchLinkType,
  isSearchRecordKind,
  isVisible,
  searchPassageSchema,
  searchRecordSchema,
  type DocumentStatus,
  type Label,
  type RecordType,
  type Role,
} from '@grc/shared';
import type { GraphLink, GraphRecord, VectorPassage } from '../retrieval.js';

export interface FilterViewer {
  role: Role;
  clearance: Label;
}

/** What Postgres says about a passage's document, read in the asker's org context. */
export interface DocumentFacts {
  id: string;
  orgId: string;
  recordType: RecordType;
  label: Label;
  status: DocumentStatus;
}

/** Whether the asker may see the passage, given its document's facts (undefined: not visible). */
export function passageVisible(
  viewer: FilterViewer,
  orgId: string,
  passage: VectorPassage,
  document: DocumentFacts | undefined,
): boolean {
  if (!searchPassageSchema.safeParse(passage).success) return false;
  if (!Array.isArray(passage.recordIds)) return false;
  if (document === undefined || document.id !== passage.documentId || document.orgId !== orgId) return false;
  if (document.status === 'removed') return false;
  if (DOCUMENT_RECORD_TYPE[passage.documentKind] !== passage.recordType) return false;
  if (!isLabel(document.label) || !isVisible(viewer.clearance, document.label)) return false;
  return (
    isRecordVisible(viewer, { recordType: passage.recordType, label: passage.label }) &&
    isRecordVisible(viewer, { recordType: document.recordType, label: document.label })
  );
}

/** Whether the asker may see the record (its kind's D50 row and its label). */
export function recordVisible(viewer: FilterViewer, record: GraphRecord): boolean {
  if (!searchRecordSchema.safeParse(record).success) return false;
  if (!isSearchRecordKind(record.kind)) return false;
  return isRecordVisible(viewer, { recordType: SEARCH_RECORD_TYPE[record.kind], label: record.label });
}

/** Whether the link may be kept: a known type, and both ends among the kept records' IDs. */
export function linkVisible(link: GraphLink, keptRecordIds: ReadonlySet<string>): boolean {
  return isSearchLinkType(link.type) && keptRecordIds.has(link.from) && keptRecordIds.has(link.to);
}

export interface FilteredPaths {
  passages: VectorPassage[];
  records: GraphRecord[];
  links: GraphLink[];
  /** How many of each the API's check dropped (0 when row security and the accounts did their job). */
  dropped: { passages: number; records: number; links: number };
}

/** The visibility checks on both paths' findings, in their own orders. */
export function filterVisible(
  viewer: FilterViewer,
  orgId: string,
  found: {
    passages: readonly VectorPassage[];
    records: readonly GraphRecord[];
    links: readonly GraphLink[];
    documents: ReadonlyMap<string, DocumentFacts>;
  },
): FilteredPaths {
  const passages = found.passages.filter((p) => passageVisible(viewer, orgId, p, found.documents.get(p.documentId)));
  const records = found.records.filter((r) => recordVisible(viewer, r));
  const keptIds = new Set(records.map((r) => r.id));
  const links = found.links.filter((l) => linkVisible(l, keptIds));
  return {
    passages,
    records,
    links,
    dropped: {
      passages: found.passages.length - passages.length,
      records: found.records.length - records.length,
      links: found.links.length - links.length,
    },
  };
}
