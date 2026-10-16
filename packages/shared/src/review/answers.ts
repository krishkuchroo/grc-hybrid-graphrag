// The review queue's answers (D38, D47, D51, D57; S5 shared notes, "Who"), shared by the read routes
// (S5-002), the removal routes (S5-004) and the web app: a list row, a finding's detail, the counts
// and a document's impact.
// - A record a finding names is shown by ID, number, name and kind only if the reader may see it
//   now (their own role x clearance read); otherwise it is `{ hidden: true }`, with nothing else.
// - A link end shows its kind and name as Gemma wrote them (the document's words, which the reader
//   may see: the finding carries the document's label) and its state: a matched record, how many
//   candidates it has, the proposed new record (that `record` finding's ID and status), or a
//   matched record the reader can't see.
// - A chunk or document the reader can't read is left out (`null`), never guessed.
// - People are named by ID and display name (`null` when the name can't be found).
import { z } from 'zod';
import { LABELS } from '../access/labels.js';
import { MAPPING_LINK_TYPES, type MappingLinkType } from '../frameworks/frameworks.js';
import { DOCUMENT_STATUSES } from '../intake/statuses.js';
import { DOCUMENT_KINDS } from '../intake/uploads.js';
import { EXTRACTION_LINK_TYPES } from '../processing/extraction.js';
import { PROPOSED_RECORD_KINDS, REVIEW_FINDING_STATUSES } from '../processing/findings.js';
import { MATCH_STEPS, MAX_MATCH_CANDIDATES } from '../processing/matching.js';
import { RULE_CHECKS } from '../processing/rule-checks.js';
import { RECORD_KINDS, RECORD_STATUSES } from '../records/types.js';
import { duplicateOutcomeSchema, linkOutcomeSchema, mappingOutcomeSchema, recordOutcomeSchema } from './outcomes.js';

const recordNumber = z.string().regex(/^[A-Z]{3}\d{7}$/);
const dateTime = z.iso.datetime({ offset: true });
const count = z.int().min(0);
const score = z.number().min(0).max(1);
const label = z.enum(LABELS);
const findingStatus = z.enum(REVIEW_FINDING_STATUSES);
const MAPPING_TYPES = MAPPING_LINK_TYPES.map((row) => row.type) as [MappingLinkType, ...MappingLinkType[]];

/** The kinds of record a finding can name: the five record kinds, and requirements (mappings). */
export const REVIEW_RECORD_KINDS = [...RECORD_KINDS, 'requirement'] as const;
export type ReviewRecordKind = (typeof REVIEW_RECORD_KINDS)[number];

/** A record the reader may see. */
export const shownRecordSchema = z.object({
  recordId: z.uuid(),
  number: recordNumber,
  name: z.string(),
  kind: z.enum(REVIEW_RECORD_KINDS),
});

/** A record the reader may not see (or that is gone): no ID, number or name. */
export const hiddenRecordSchema = z.object({ hidden: z.literal(true) });

/** A record a finding names, as the reader may see it. */
export const namedRecordSchema = z.union([shownRecordSchema, hiddenRecordSchema]);

/** A person, by user ID and display name. */
export const reviewPersonSchema = z.object({ id: z.string(), name: z.string().nullable() });

/** Who stored a document: a person, a machine API key, or the system (fast load). */
export const DOCUMENT_UPLOADER_TYPES = ['user', 'api_key', 'system'] as const;
export type DocumentUploaderType = (typeof DOCUMENT_UPLOADER_TYPES)[number];

export const reviewUploaderSchema = z.object({
  type: z.enum(DOCUMENT_UPLOADER_TYPES),
  id: z.string(),
  name: z.string().nullable(),
});

/** A finding's source document in a list row: its ID, file name and kind. */
export const reviewSourceDocumentSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  kind: z.enum(DOCUMENT_KINDS),
});

/** The source document in a finding's detail: also its label, uploader and upload time. */
export const reviewDocumentSchema = reviewSourceDocumentSchema.extend({
  label,
  uploader: reviewUploaderSchema,
  uploadedAt: dateTime,
});

// ---- Link ends -----------------------------------------------------------------------------

/** Where a link end stands. */
export const LINK_END_STATES = ['matched', 'candidates', 'proposed', 'hidden'] as const;
export type LinkEndState = (typeof LINK_END_STATES)[number];

const endBase = { kind: z.enum(RECORD_KINDS), name: z.string() };

const matchedEnd = z.object({ ...endBase, state: z.literal('matched'), record: shownRecordSchema });
const candidatesEnd = z.object({ ...endBase, state: z.literal('candidates'), candidateCount: count });
const proposedEnd = z.object({
  ...endBase,
  state: z.literal('proposed'),
  findingId: z.uuid(),
  status: findingStatus,
});
const hiddenEnd = z.object({ ...endBase, state: z.literal('hidden') });

/** A link end in a list row. */
export const linkEndSummarySchema = z.discriminatedUnion('state', [matchedEnd, candidatesEnd, proposedEnd, hiddenEnd]);

/** A record an uncertain end may mean, with the matching step that found it and its score. */
export const reviewCandidateSchema = z.object({
  record: namedRecordSchema,
  step: z.enum(MATCH_STEPS),
  score,
});

const candidates = { candidates: z.array(reviewCandidateSchema).max(MAX_MATCH_CANDIDATES) };

/** A link end in a finding's detail: the row's, plus its full candidates. */
export const linkEndDetailSchema = z.discriminatedUnion('state', [
  matchedEnd.extend(candidates),
  candidatesEnd.extend(candidates),
  proposedEnd.extend(candidates),
  hiddenEnd.extend(candidates),
]);

// ---- Per-kind summaries ----------------------------------------------------------------------

export const linkSummarySchema = z.object({
  type: z.enum(EXTRACTION_LINK_TYPES),
  failedChecks: z.array(z.enum(RULE_CHECKS)),
  from: linkEndSummarySchema,
  to: linkEndSummarySchema,
});

export const recordSummarySchema = z.object({
  recordKind: z.enum(PROPOSED_RECORD_KINDS),
  name: z.string(),
  /** How many link findings point to this proposed record. */
  linkFindingCount: count,
});

export const duplicateSummarySchema = z.object({
  recordKind: z.enum(RECORD_KINDS),
  /** The record kept if they are one (the proposal's), and the other. */
  kept: namedRecordSchema,
  other: namedRecordSchema,
  step: z.enum(MATCH_STEPS),
  score,
});

export const mappingSummarySchema = z.object({
  type: z.enum(MAPPING_TYPES),
  from: namedRecordSchema,
  to: namedRecordSchema,
});

// ---- The list row ----------------------------------------------------------------------------

const rowBase = {
  id: z.uuid(),
  status: findingStatus,
  label,
  createdAt: dateTime,
  decidedBy: reviewPersonSchema.nullable(),
  decidedAt: dateTime.nullable(),
  /** `null` for duplicates and mappings, which have no source, and for a document the reader can't read. */
  document: reviewSourceDocumentSchema.nullable(),
};

/** One finding in the queue's list, with its kind's summary. */
export const reviewFindingRowSchema = z.discriminatedUnion('kind', [
  z.object({ ...rowBase, kind: z.literal('link'), summary: linkSummarySchema }),
  z.object({ ...rowBase, kind: z.literal('record'), summary: recordSummarySchema }),
  z.object({ ...rowBase, kind: z.literal('duplicate'), summary: duplicateSummarySchema }),
  z.object({ ...rowBase, kind: z.literal('mapping'), summary: mappingSummarySchema }),
]);

export const pagedReviewFindingsSchema = z.object({
  items: z.array(reviewFindingRowSchema),
  page: z.int(),
  pageSize: z.int(),
  total: z.int(),
});

// ---- The detail ------------------------------------------------------------------------------

/** Where the sentence sits in the chunk's text (UTF-16 offsets, `end` exclusive). */
export const sentencePlaceSchema = z
  .object({ start: count, end: count })
  .refine((p) => p.end >= p.start, { path: ['end'], message: 'ends before it starts' });

export const reviewChunkSchema = z.object({
  id: z.uuid(),
  text: z.string(),
  /** `null` when the sentence isn't found in the text. */
  sentenceAt: sentencePlaceSchema.nullable(),
});

/** A link finding pointing to a proposed record: its ID, status and type, which end the proposed
 * record is, and the other end. */
export const pointingLinkFindingSchema = z.object({
  id: z.uuid(),
  status: findingStatus,
  type: z.enum(EXTRACTION_LINK_TYPES),
  side: z.enum(['from', 'to']),
  other: linkEndSummarySchema,
});

/** One of a possible duplicate pair, in full. */
export const duplicateRecordDetailSchema = z.union([
  shownRecordSchema.extend({
    label,
    status: z.enum(RECORD_STATUSES),
    owner: reviewPersonSchema,
    sourceIds: z.array(z.string()),
    linkCount: count,
  }),
  hiddenRecordSchema,
]);

/** One end of a suggested mapping, in full: for a requirement its framework, code and title; for a
 * control its code and framework as written on it (`title` is `null`). */
export const mappingEndDetailSchema = z.union([
  shownRecordSchema.extend({
    label,
    status: z.enum(RECORD_STATUSES),
    framework: z.string().nullable(),
    code: z.string().nullable(),
    title: z.string().nullable(),
  }),
  hiddenRecordSchema,
]);

const detailBase = {
  ...rowBase,
  document: reviewDocumentSchema.nullable(),
  /** The sentence the link came from (link findings only). */
  sentence: z.string().nullable(),
  /** The chunk the sentence came from, with the sentence's place in it (link findings only). */
  chunk: reviewChunkSchema.nullable(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  /** The Analyst's note on the decision. */
  note: z.string().nullable(),
};

/** One finding in full, with its kind's details and the decision's outcome (`null` until decided,
 * and for a rejection). */
export const reviewFindingDetailSchema = z.discriminatedUnion('kind', [
  z.object({
    ...detailBase,
    kind: z.literal('link'),
    summary: linkSummarySchema.extend({ from: linkEndDetailSchema, to: linkEndDetailSchema }),
    outcome: linkOutcomeSchema.nullable(),
  }),
  z.object({
    ...detailBase,
    kind: z.literal('record'),
    summary: recordSummarySchema.extend({
      /** Gemma's details, as written (for example `{ severity: "High" }`). */
      details: z.record(z.string(), z.string()).nullable(),
      linkFindings: z.array(pointingLinkFindingSchema),
    }),
    outcome: recordOutcomeSchema.nullable(),
  }),
  z.object({
    ...detailBase,
    kind: z.literal('duplicate'),
    summary: duplicateSummarySchema.extend({ kept: duplicateRecordDetailSchema, other: duplicateRecordDetailSchema }),
    outcome: duplicateOutcomeSchema.nullable(),
  }),
  z.object({
    ...detailBase,
    kind: z.literal('mapping'),
    summary: mappingSummarySchema.extend({
      /** Gemma's short reason for the suggestion. */
      reason: z.string(),
      from: mappingEndDetailSchema,
      to: mappingEndDetailSchema,
    }),
    outcome: mappingOutcomeSchema.nullable(),
  }),
]);

// ---- Counts and a document's impact -------------------------------------------------------------

/** Pending findings per kind, and their total, in the reader's view. */
export const reviewCountsSchema = z.object({
  pending: z.object({ link: count, record: count, duplicate: count, mapping: count }),
  total: count,
});

/** What removing one upload would touch (D52.5): the document and its counts. */
export const reviewDocumentImpactSchema = z.object({
  document: reviewDocumentSchema.extend({ status: z.enum(DOCUMENT_STATUSES) }),
  counts: z.object({
    /** Live AI links in the graph whose source is this document. */
    liveAiLinks: count,
    /** Records created by approving this document's `record` findings. */
    approvedRecords: count,
    pendingFindings: count,
    liveOrApprovedFindings: count,
  }),
});

export type ShownRecord = z.infer<typeof shownRecordSchema>;
export type HiddenRecord = z.infer<typeof hiddenRecordSchema>;
export type NamedRecord = z.infer<typeof namedRecordSchema>;
export type ReviewPerson = z.infer<typeof reviewPersonSchema>;
export type ReviewUploader = z.infer<typeof reviewUploaderSchema>;
export type ReviewSourceDocument = z.infer<typeof reviewSourceDocumentSchema>;
export type ReviewDocument = z.infer<typeof reviewDocumentSchema>;
export type LinkEndSummary = z.infer<typeof linkEndSummarySchema>;
export type LinkEndDetail = z.infer<typeof linkEndDetailSchema>;
export type ReviewCandidate = z.infer<typeof reviewCandidateSchema>;
export type LinkSummary = z.infer<typeof linkSummarySchema>;
export type RecordSummary = z.infer<typeof recordSummarySchema>;
export type DuplicateSummary = z.infer<typeof duplicateSummarySchema>;
export type MappingSummary = z.infer<typeof mappingSummarySchema>;
export type ReviewFindingRow = z.infer<typeof reviewFindingRowSchema>;
export type PagedReviewFindings = z.infer<typeof pagedReviewFindingsSchema>;
export type SentencePlace = z.infer<typeof sentencePlaceSchema>;
export type ReviewChunk = z.infer<typeof reviewChunkSchema>;
export type PointingLinkFinding = z.infer<typeof pointingLinkFindingSchema>;
export type DuplicateRecordDetail = z.infer<typeof duplicateRecordDetailSchema>;
export type MappingEndDetail = z.infer<typeof mappingEndDetailSchema>;
export type ReviewFindingDetail = z.infer<typeof reviewFindingDetailSchema>;
export type ReviewCounts = z.infer<typeof reviewCountsSchema>;
export type ReviewDocumentImpact = z.infer<typeof reviewDocumentImpactSchema>;
