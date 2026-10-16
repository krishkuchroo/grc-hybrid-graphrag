// Review findings (D16, D24, D38, D43, D73; S4 shared notes, "`review_findings`"): one row per
// proposal, its kind, its status, and a schema for each kind's proposal. The row's other columns
// (source document, chunk and sentence, failed checks, label, model and prompt version, key) live
// beside the proposal, not in it. Named `review` findings so they never clash with S3's audit findings.
import { z } from 'zod';
import { parseCatalogNumber } from '../frameworks/numbers.js';
import { MAPPING_LINK_TYPES, type MappingLinkType } from '../frameworks/frameworks.js';
import { parseNumber } from '../records/numbers.js';
import { RECORD_KINDS } from '../records/types.js';
import { EXTRACTION_LINK_TYPES, extractedDetailsSchema, extractedNameSchema } from './extraction.js';
import { MATCH_STEPS, MAX_MATCH_CANDIDATES } from './matching.js';

/** `link`: a proposed link. `record`: a proposed new risk, control, policy or incident. `duplicate`:
 * two records that may be one. `mapping`: a suggested `SATISFIES` or `MAPS_TO`. */
export const REVIEW_FINDING_KINDS = ['link', 'record', 'duplicate', 'mapping'] as const;
export type ReviewFindingKind = (typeof REVIEW_FINDING_KINDS)[number];

export function isReviewFindingKind(v: unknown): v is ReviewFindingKind {
  return typeof v === 'string' && (REVIEW_FINDING_KINDS as readonly string[]).includes(v);
}

/** `pending` waits for the Analyst; `live` was made live by the rule checks (kept so S5 and the
 * benchmark see every proposal); `approved`, `rejected` and `removed` are set only by the Analyst (S5). */
export const REVIEW_FINDING_STATUSES = ['pending', 'live', 'approved', 'rejected', 'removed'] as const;
export type ReviewFindingStatus = (typeof REVIEW_FINDING_STATUSES)[number];

export function isReviewFindingStatus(v: unknown): v is ReviewFindingStatus {
  return typeof v === 'string' && (REVIEW_FINDING_STATUSES as readonly string[]).includes(v);
}

/** The kinds the AI may propose as new records: never an asset, which come only from asset lists (D40). */
export const PROPOSED_RECORD_KINDS = ['risk', 'control', 'policy', 'incident'] as const;
export type ProposedRecordKind = (typeof PROPOSED_RECORD_KINDS)[number];

const score = z.number().min(0).max(1);
const recordNumber = z.string().regex(/^[A-Z]{3}\d{7}$/);

/** An existing record, by its internal ID and its on-screen number. */
export const recordRefSchema = z.strictObject({ recordId: z.uuid(), number: recordNumber });

/** A record a name may mean, with the step that found it and its score. */
export const matchCandidateSchema = z.strictObject({
  recordId: z.uuid(),
  number: recordNumber,
  name: z.string().min(1),
  step: z.enum(MATCH_STEPS),
  score,
});

/** One end of a proposed link: its kind and name as Gemma wrote them, the clear match (or none),
 * up to 3 candidates, and the `record` finding it points to when the end is a proposed new record. */
export const linkEndProposalSchema = z
  .strictObject({
    kind: z.enum(RECORD_KINDS),
    name: extractedNameSchema,
    match: recordRefSchema.nullable(),
    candidates: z.array(matchCandidateSchema).max(MAX_MATCH_CANDIDATES),
    recordFindingId: z.uuid().nullable(),
  })
  .superRefine((end, ctx) => {
    if (end.recordFindingId === null) return;
    if (end.match !== null) {
      ctx.addIssue({ code: 'custom', path: ['recordFindingId'], message: 'a clearly matched end is no new record' });
    }
    if (!(PROPOSED_RECORD_KINDS as readonly string[]).includes(end.kind)) {
      ctx.addIssue({ code: 'custom', path: ['recordFindingId'], message: 'assets are never proposed' });
    }
  });

/** A proposed link: one of the 7 spec types (its direction may be wrong: that's a failed check). */
export const linkProposalSchema = z.strictObject({
  type: z.enum(EXTRACTION_LINK_TYPES),
  from: linkEndProposalSchema,
  to: linkEndProposalSchema,
});

/** A proposed new record, as Gemma wrote it. */
export const recordProposalSchema = z.strictObject({
  kind: z.enum(PROPOSED_RECORD_KINDS),
  name: extractedNameSchema,
  details: extractedDetailsSchema.optional(),
});

/** Two records of one kind that may be one: the one kept if they are, the other, the step and score. */
export const duplicateProposalSchema = z
  .strictObject({
    kind: z.enum(RECORD_KINDS),
    kept: recordRefSchema,
    other: recordRefSchema,
    step: z.enum(MATCH_STEPS),
    score,
  })
  .superRefine((proposal, ctx) => {
    if (proposal.kept.recordId === proposal.other.recordId) {
      ctx.addIssue({ code: 'custom', path: ['other'], message: 'a record is no duplicate of itself' });
    }
  });

const MAPPING_TYPES = MAPPING_LINK_TYPES.map((row) => row.type) as [MappingLinkType, ...MappingLinkType[]];

/** The most Gemma's reason for a mapping may hold. */
export const MAPPING_REASON_MAX_LENGTH = 300;

/** A suggested mapping (D16 (b), D20, D212 (4)): `SATISFIES` from a control to a requirement, or
 * `MAPS_TO` from one requirement to another, with Gemma's short reason. */
export const mappingProposalSchema = z
  .strictObject({
    type: z.enum(MAPPING_TYPES),
    from: recordRefSchema,
    to: recordRefSchema,
    reason: z.string().min(1).max(MAPPING_REASON_MAX_LENGTH).regex(/\S/, 'must not be blank'),
  })
  .superRefine((proposal, ctx) => {
    const fromKind =
      proposal.type === 'SATISFIES'
        ? parseNumber(proposal.from.number)?.kind
        : parseCatalogNumber(proposal.from.number)?.kind;
    const expected = proposal.type === 'SATISFIES' ? 'control' : 'requirement';
    if (fromKind !== expected) {
      ctx.addIssue({ code: 'custom', path: ['from', 'number'], message: `must be a ${expected} number` });
    }
    if (parseCatalogNumber(proposal.to.number)?.kind !== 'requirement') {
      ctx.addIssue({ code: 'custom', path: ['to', 'number'], message: 'must be a requirement number' });
    }
    if (proposal.from.recordId === proposal.to.recordId) {
      ctx.addIssue({ code: 'custom', path: ['to'], message: 'a record maps to another record' });
    }
  });

/** Each kind's proposal schema. */
export const proposalSchemas = {
  link: linkProposalSchema,
  record: recordProposalSchema,
  duplicate: duplicateProposalSchema,
  mapping: mappingProposalSchema,
} as const satisfies Record<ReviewFindingKind, z.ZodType>;

export type RecordRef = z.infer<typeof recordRefSchema>;
export type MatchCandidate = z.infer<typeof matchCandidateSchema>;
export type LinkEndProposal = z.infer<typeof linkEndProposalSchema>;
export type LinkProposal = z.infer<typeof linkProposalSchema>;
export type RecordProposal = z.infer<typeof recordProposalSchema>;
export type DuplicateProposal = z.infer<typeof duplicateProposalSchema>;
export type MappingProposal = z.infer<typeof mappingProposalSchema>;
export type ProposalOf<K extends ReviewFindingKind> = z.infer<(typeof proposalSchemas)[K]>;
