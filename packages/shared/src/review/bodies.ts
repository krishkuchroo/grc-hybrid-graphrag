// The review decisions' request bodies (D30, D47; S5 shared notes): approve per kind, reject, remove,
// and removing a whole upload. Every body refuses unknown fields. A note is trimmed and 1 to 1,000
// characters; it is the Analyst's own words and goes in the decision's audit entry, never in a log.
// - link `{ from?, to?, note? }`: `from` and `to` are the records the Analyst chose for an end that
//   wasn't a clear match, among that end's candidates (the API checks that).
// - record `{ record, note? }`: `record` is S1's create body for the proposal's kind (risk, control,
//   policy or incident), name included, so a body missing its kind's required fields is refused.
// - duplicate `{ keep?, note? }`: the ID of the one of the two records to keep.
// - mapping `{ note? }`.
// - reject, remove and document removal `{ note? }`.
import { z } from 'zod';
import { PROPOSED_RECORD_KINDS, type ProposedRecordKind, type ReviewFindingKind } from '../processing/findings.js';
import { createSchemas } from '../records/schemas.js';

/** The most an Analyst's note may hold, after trimming. */
export const REVIEW_NOTE_MAX_LENGTH = 1000;

/** A note: trimmed, then 1 to 1,000 characters. */
export const reviewNoteSchema = z.string().trim().min(1).max(REVIEW_NOTE_MAX_LENGTH);

/** A record's internal ID (lowercase, as in Neo4j and Postgres). */
const recordId = z.uuid().toLowerCase();
const note = reviewNoteSchema.optional();

export const linkApproveBodySchema = z.strictObject({ from: recordId.optional(), to: recordId.optional(), note });

function recordApproveBody<K extends ProposedRecordKind>(kind: K) {
  return z.strictObject({ record: createSchemas[kind], note });
}

/** A record finding's approve body, by the proposal's kind. */
export const recordApproveBodySchemas = {
  risk: recordApproveBody('risk'),
  control: recordApproveBody('control'),
  policy: recordApproveBody('policy'),
  incident: recordApproveBody('incident'),
} as const satisfies Record<ProposedRecordKind, z.ZodType>;

export const duplicateApproveBodySchema = z.strictObject({ keep: recordId.optional(), note });

export const mappingApproveBodySchema = z.strictObject({ note });

/** Rejecting or removing a finding. */
export const reviewDecisionBodySchema = z.strictObject({ note });
export const rejectBodySchema = reviewDecisionBodySchema;
export const removeBodySchema = reviewDecisionBodySchema;

/** Removing everything from one upload (D52.5). */
export const documentRemoveBodySchema = reviewDecisionBodySchema;

/** Every approve body, for the route's documentation. The API parses a body with
 * `parseApproveBody` once it knows the finding's kind. */
export const approveBodySchema = z.union([
  linkApproveBodySchema,
  recordApproveBodySchemas.risk,
  recordApproveBodySchemas.control,
  recordApproveBodySchemas.policy,
  recordApproveBodySchemas.incident,
  duplicateApproveBodySchema,
  mappingApproveBodySchema,
]);

export type LinkApproveBody = z.infer<typeof linkApproveBodySchema>;
export type RecordApproveBody<K extends ProposedRecordKind = ProposedRecordKind> = z.infer<
  (typeof recordApproveBodySchemas)[K]
>;
export type DuplicateApproveBody = z.infer<typeof duplicateApproveBodySchema>;
export type MappingApproveBody = z.infer<typeof mappingApproveBodySchema>;
export type ReviewDecisionBody = z.infer<typeof reviewDecisionBodySchema>;
export type DocumentRemoveBody = z.infer<typeof documentRemoveBodySchema>;
export type ApproveBody = z.infer<typeof approveBodySchema>;

/** Each kind's approve body, with the proposal's kind for a record finding. */
export type ApproveBodyFor =
  | { kind: 'link'; body: LinkApproveBody }
  | { kind: 'record'; recordKind: ProposedRecordKind; body: RecordApproveBody }
  | { kind: 'duplicate'; body: DuplicateApproveBody }
  | { kind: 'mapping'; body: MappingApproveBody };

function isProposedRecordKind(v: unknown): v is ProposedRecordKind {
  return typeof v === 'string' && (PROPOSED_RECORD_KINDS as readonly string[]).includes(v);
}

/**
 * Checks an approve body for a finding of this kind; for a `record` finding, `recordKind` is the
 * proposal's kind. A body that doesn't fit throws a ZodError (answered as 400). An unknown kind or
 * proposed record kind throws a plain Error: that is a stored finding the code doesn't know, never
 * the caller's mistake, so nothing is approved (fail safe).
 */
export function parseApproveBody(
  kind: ReviewFindingKind | string,
  recordKind: string | null | undefined,
  body: unknown,
): ApproveBodyFor {
  const input = body ?? {};
  switch (kind) {
    case 'link':
      return { kind, body: linkApproveBodySchema.parse(input) };
    case 'record':
      if (!isProposedRecordKind(recordKind)) throw new Error('approve body: unknown proposed record kind');
      return { kind, recordKind, body: recordApproveBodySchemas[recordKind].parse(input) };
    case 'duplicate':
      return { kind, body: duplicateApproveBodySchema.parse(input) };
    case 'mapping':
      return { kind, body: mappingApproveBodySchema.parse(input) };
    default:
      throw new Error('approve body: unknown finding kind');
  }
}
