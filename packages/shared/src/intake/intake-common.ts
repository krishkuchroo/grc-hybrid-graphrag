// What the Evidence and Audit finding models share (internal to src/intake/, not exported from the
// package): calendar-date arithmetic for the date rules, and the field rules S1's records use.
// Pure: no clock, the caller always passes today. Days are counted on the proleptic Gregorian
// calendar, so month lengths and leap years are right without `Date`.
import { z } from 'zod';
import { LABELS } from '../access/labels.js';
import { RECORD_ORIGINS, RECORD_STATUSES } from '../records/types.js';

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

function isLeapYear(y: number): boolean {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

function daysInMonth(y: number, m: number): number {
  if (m === 2) return isLeapYear(y) ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** The day count of a real `YYYY-MM-DD` date (1970-01-01 is 0), or `null` for anything else. */
export function dayNumber(date: unknown): number | null {
  const match = typeof date === 'string' ? DATE_PATTERN.exec(date) : null;
  if (!match) return null;
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return null;
  // Days from the civil date (H. Hinnant), with March as the first month of the year.
  const yy = m <= 2 ? y - 1 : y;
  const era = Math.floor(yy / 400);
  const yearOfEra = yy - era * 400;
  const monthFromMarch = (m + 9) % 12;
  const dayOfYear = Math.floor((153 * monthFromMarch + 2) / 5) + d - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146_097 + dayOfEra - 719_468;
}

/** The day count of `today`, which must be a real date: a malformed one is the caller's bug. */
export function todayNumber(today: unknown): number {
  const n = dayNumber(today);
  if (n === null) throw new Error('today must be a YYYY-MM-DD date');
  return n;
}

/** A date problem, named by its field, for a schema issue or a 400 answer. */
export interface DateProblem {
  field: string;
  code: string;
}

/** Adds each problem as a schema issue on its own field. */
export function addProblems(
  ctx: z.RefinementCtx,
  problems: readonly DateProblem[],
  message: (p: DateProblem) => string,
): void {
  for (const p of problems) ctx.addIssue({ code: 'custom', path: [p.field], message: message(p) });
}

// S1's field rules (packages/shared/src/records/schemas.ts).
export const nameField = z.string().trim().min(1);
export const userIdField = z.string().min(1);
export const labelField = z.enum(LABELS);
export const dateField = z.iso.date();
export const dateTimeField = z.iso.datetime({ offset: true });

/** Text with something in it, up to `max` characters. */
export function textField(max: number) {
  return z.string().trim().min(1).max(max);
}

/** The fields every record has, as S1's records, with the kind's own number prefix. */
export function commonRecordFields(prefix: string) {
  return {
    id: z.uuid(),
    number: z.string().regex(new RegExp(`^${prefix}\\d{7}$`)),
    sourceIds: z.array(z.string()),
    name: z.string(),
    label: labelField,
    status: z.enum(RECORD_STATUSES),
    owner: userIdField,
    version: z.int().min(1),
    createdAt: dateTimeField,
    createdBy: userIdField,
    updatedAt: dateTimeField,
    updatedBy: userIdField,
    origin: z.enum(RECORD_ORIGINS),
  };
}

export const versionField = z.int().min(1);
