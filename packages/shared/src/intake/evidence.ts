// Evidence (D202, D213 (2)): a file that shows a control works. Its review statuses, its
// "Expiring soon" rule, its date rules and its create, update and record schemas (D30, D51, D73).
// Pure: every date rule takes today from the caller.
import { z } from 'zod';
import { FILE_FORMATS } from './file-format.js';
import {
  addProblems,
  commonRecordFields,
  dateField,
  dateTimeField,
  dayNumber,
  labelField,
  nameField,
  todayNumber,
  userIdField,
  versionField,
} from './intake-common.js';
import { INTAKE_NUMBER_PREFIX } from './intake-numbers.js';
import { MAX_FILE_NAME_LENGTH, MAX_UPLOAD_BYTES } from './uploads.js';

/** New evidence is `pending`; only the review route (S3-021) sets the others. */
export const EVIDENCE_REVIEW_STATUSES = ['pending', 'accepted', 'rejected'] as const;
export type EvidenceReviewStatus = (typeof EVIDENCE_REVIEW_STATUSES)[number];

/** Evidence whose valid-until date is this many days ahead or fewer is "Expiring soon". */
export const EXPIRING_SOON_DAYS = 30;

export const EVIDENCE_VALIDITIES = ['valid', 'expiring', 'expired'] as const;
export type EvidenceValidity = (typeof EVIDENCE_VALIDITIES)[number];

/**
 * No valid-until date is `valid`; a date before today is `expired`; today up to EXPIRING_SOON_DAYS
 * days ahead is `expiring`; later is `valid`. A malformed valid-until date counts as `expired`
 * (fail safe); a malformed `today` throws.
 */
export function evidenceValidity(validUntil: string | null | undefined, today: string): EvidenceValidity {
  const now = todayNumber(today);
  if (validUntil === null || validUntil === undefined) return 'valid';
  const until = dayNumber(validUntil);
  if (until === null || until < now) return 'expired';
  return until - now <= EXPIRING_SOON_DAYS ? 'expiring' : 'valid';
}

export interface EvidenceDateProblem {
  field: 'collectedDate' | 'validUntil';
  code: 'in_future' | 'before_collected';
}

interface EvidenceDates {
  collectedDate?: string | undefined;
  validUntil?: string | null | undefined;
}

/** `today` null skips the "not after today" rule; a rule runs only when its dates are both given. */
function problems(e: EvidenceDates, today: number | null): EvidenceDateProblem[] {
  const found: EvidenceDateProblem[] = [];
  const collected = dayNumber(e.collectedDate);
  const until = dayNumber(e.validUntil);
  if (today !== null && collected !== null && collected > today) {
    found.push({ field: 'collectedDate', code: 'in_future' });
  }
  if (collected !== null && until !== null && until < collected) {
    found.push({ field: 'validUntil', code: 'before_collected' });
  }
  return found;
}

/** The evidence date rules as one pure check: the collected date isn't after today, and the
 * valid-until date (when there is one) is on or after it. Run it again on a merged update. */
export function evidenceDateProblems(
  e: { collectedDate: string; validUntil?: string | null },
  today: string,
): EvidenceDateProblem[] {
  return problems(e, todayNumber(today));
}

export function evidenceDateMessage(p: { field: string; code: string }): string {
  if (p.code === 'in_future') return `${p.field} must not be after today`;
  if (p.code === 'before_collected') return `${p.field} must be on or after collectedDate`;
  return `${p.field} is not a valid date`;
}

/** What a person sends. The file and the control it supports come with the create request
 * (S3-009); the review fields are not here, so sending them is refused as an unknown field. */
const inputFields = {
  name: nameField,
  collectedDate: dateField,
  validUntil: dateField.nullable().optional(),
  label: labelField.optional(),
  owner: userIdField.optional(),
};

function day(today: string | null): number | null {
  return today === null ? null : todayNumber(today);
}

/** The create schema; with `today`, a collected date after it is refused too. */
export function buildEvidenceCreateSchema(today: string | null) {
  const now = day(today);
  return z.strictObject(inputFields).superRefine((v, ctx) => addProblems(ctx, problems(v, now), evidenceDateMessage));
}

/** The update schema: every create field optional, plus the required `version`. */
export function buildEvidenceUpdateSchema(today: string | null) {
  const now = day(today);
  return z
    .strictObject(inputFields)
    .partial()
    .extend({ version: versionField })
    .superRefine((v, ctx) => addProblems(ctx, problems(v, now), evidenceDateMessage));
}

/** Evidence as the API returns it: S1's common fields plus its own. */
export const evidenceRecordSchema = z.object({
  ...commonRecordFields(INTAKE_NUMBER_PREFIX.evidence),
  collectedDate: dateField,
  validUntil: dateField.nullable(),
  fileKey: z.string().regex(/^sha256\/[0-9a-f]{64}$/),
  fileHash: z.string().regex(/^[0-9a-f]{64}$/),
  documentId: z.uuid(),
  fileName: z.string().min(1).max(MAX_FILE_NAME_LENGTH),
  format: z.enum(FILE_FORMATS),
  sizeBytes: z.int().min(1).max(MAX_UPLOAD_BYTES),
  reviewStatus: z.enum(EVIDENCE_REVIEW_STATUSES),
  reviewedBy: userIdField.nullable(),
  reviewedAt: dateTimeField.nullable(),
});

export type EvidenceRecord = z.infer<typeof evidenceRecordSchema>;
