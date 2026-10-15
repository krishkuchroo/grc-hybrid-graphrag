// Audit findings (D202, D213 (2)): what an audit found. Their value lists (stored lowercase with
// `_`), the overdue rule and the date rules (planner's reading R15), and their create, update and
// record schemas (D30, D51, D73). Pure: every date rule takes today from the caller.
import { z } from 'zod';
import {
  addProblems,
  commonRecordFields,
  dateField,
  dayNumber,
  labelField,
  nameField,
  textField,
  todayNumber,
  userIdField,
  versionField,
} from './intake-common.js';
import { INTAKE_NUMBER_PREFIX } from './intake-numbers.js';

export const FINDING_SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** `findingStatus`, named so it doesn't clash with every record's `status` (active or retired). */
export const FINDING_STATUSES = ['open', 'in_progress', 'remediated', 'risk_accepted', 'closed'] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/** The statuses in which a finding can be overdue (R15). */
export const OPEN_FINDING_STATUSES = ['open', 'in_progress'] as const;
export type OpenFindingStatus = (typeof OPEN_FINDING_STATUSES)[number];

/** The most characters each text field holds. */
export const FINDING_TEXT_LIMITS = Object.freeze({
  sourceReference: 200,
  rootCause: 4000,
  remediationPlan: 4000,
  description: 4000,
});

/** Due before today, with an open status (R15). A malformed due date is not overdue; a malformed
 * `today` throws. */
export function isFindingOverdue(f: { dueDate: string; findingStatus: string }, today: string): boolean {
  const now = todayNumber(today);
  const due = dayNumber(f.dueDate);
  if (due === null) return false;
  return due < now && (OPEN_FINDING_STATUSES as readonly string[]).includes(f.findingStatus);
}

export interface FindingDateProblem {
  field: 'identifiedDate' | 'dueDate' | 'closedDate';
  code: 'in_future' | 'before_identified' | 'required' | 'not_allowed';
}

interface FindingDates {
  findingStatus?: string | undefined;
  identifiedDate?: string | undefined;
  dueDate?: string | undefined;
  closedDate?: string | null | undefined;
}

/**
 * The date rules. `today` null skips the "not after today" rules. In `partial` mode (an update's
 * changes before they're merged) the closed-date rule runs only when the changes name both
 * `findingStatus` and `closedDate`; every other rule runs only when its dates are given.
 */
function problems(f: FindingDates, today: number | null, partial: boolean): FindingDateProblem[] {
  const found: FindingDateProblem[] = [];
  const identified = dayNumber(f.identifiedDate);
  const due = dayNumber(f.dueDate);
  const closed = dayNumber(f.closedDate);
  const hasClosedDate = f.closedDate !== undefined && f.closedDate !== null;

  if (today !== null && identified !== null && identified > today) {
    found.push({ field: 'identifiedDate', code: 'in_future' });
  }
  if (identified !== null && due !== null && due < identified) {
    found.push({ field: 'dueDate', code: 'before_identified' });
  }
  const closedRuleApplies = f.findingStatus !== undefined && (!partial || f.closedDate !== undefined);
  const notAllowed = closedRuleApplies && f.findingStatus !== 'closed' && hasClosedDate;
  if (closedRuleApplies && f.findingStatus === 'closed' && !hasClosedDate) {
    found.push({ field: 'closedDate', code: 'required' });
  }
  if (notAllowed) found.push({ field: 'closedDate', code: 'not_allowed' });
  if (closed !== null && !notAllowed) {
    if (identified !== null && closed < identified) found.push({ field: 'closedDate', code: 'before_identified' });
    if (today !== null && closed > today) found.push({ field: 'closedDate', code: 'in_future' });
  }
  return found;
}

/**
 * The finding date rules as one pure check (R15): the identified date isn't after today; the due
 * date is on or after it; a closed date is required when the status is `closed` and refused
 * otherwise, and is on or after the identified date and not after today. The schemas use it, and
 * the API runs it again on the merged record after an update.
 */
export function findingDateProblems(
  f: { findingStatus: string; identifiedDate: string; dueDate: string; closedDate?: string | null },
  today: string,
): FindingDateProblem[] {
  return problems(f, todayNumber(today), false);
}

export function findingDateMessage(p: { field: string; code: string }): string {
  switch (p.code) {
    case 'in_future':
      return `${p.field} must not be after today`;
    case 'before_identified':
      return `${p.field} must be on or after identifiedDate`;
    case 'required':
      return `${p.field} is required when findingStatus is closed`;
    case 'not_allowed':
      return `${p.field} is allowed only when findingStatus is closed`;
    default:
      return `${p.field} is not a valid date`;
  }
}

/** What a person sends, but `concernsId`, which only the create request carries. */
const inputFields = {
  name: nameField,
  severity: z.enum(FINDING_SEVERITIES),
  findingStatus: z.enum(FINDING_STATUSES),
  owner: userIdField.optional(),
  sourceReference: textField(FINDING_TEXT_LIMITS.sourceReference),
  rootCause: textField(FINDING_TEXT_LIMITS.rootCause),
  remediationPlan: textField(FINDING_TEXT_LIMITS.remediationPlan),
  identifiedDate: dateField,
  dueDate: dateField,
  closedDate: dateField.nullable().optional(),
  description: z.string().trim().max(FINDING_TEXT_LIMITS.description).nullable().optional(),
  label: labelField.optional(),
};

function day(today: string | null): number | null {
  return today === null ? null : todayNumber(today);
}

/** The create schema, with the control or risk the finding concerns (R11); with `today`, an
 * identified or closed date after it is refused too. */
export function buildAuditFindingCreateSchema(today: string | null) {
  const now = day(today);
  return z
    .strictObject({ ...inputFields, concernsId: z.uuid() })
    .superRefine((v, ctx) => addProblems(ctx, problems(v, now, false), findingDateMessage));
}

/** The update schema: every create field but `concernsId`, optional, plus the required `version`.
 * Links change through the concerns routes (S3-010). */
export function buildAuditFindingUpdateSchema(today: string | null) {
  const now = day(today);
  return z
    .strictObject(inputFields)
    .partial()
    .extend({ version: versionField })
    .superRefine((v, ctx) => addProblems(ctx, problems(v, now, true), findingDateMessage));
}

/** A finding as the API returns it: S1's common fields plus its own (every field but `concernsId`). */
export const auditFindingRecordSchema = z.object({
  ...commonRecordFields(INTAKE_NUMBER_PREFIX.audit_finding),
  severity: z.enum(FINDING_SEVERITIES),
  findingStatus: z.enum(FINDING_STATUSES),
  sourceReference: z.string(),
  rootCause: z.string(),
  remediationPlan: z.string(),
  identifiedDate: dateField,
  dueDate: dateField,
  closedDate: dateField.nullable(),
  description: z.string().nullable(),
});

export type AuditFindingRecord = z.infer<typeof auditFindingRecordSchema>;
