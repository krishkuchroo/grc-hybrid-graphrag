// Record numbers (D68, D196): a prefix per kind plus 7 digits, for example `RSK0001014`.
import { RECORD_KINDS, isRecordKind, type RecordKind } from './types.js';

export const NUMBER_PREFIX = {
  risk: 'RSK',
  asset: 'AST',
  control: 'CTL',
  policy: 'POL',
  incident: 'INC',
} as const satisfies Record<RecordKind, string>;

/** Counting starts here, per org and per type (D196). */
export const FIRST_NUMBER = 1001;

const DIGITS = 7;
const MAX_NUMBER = 9_999_999;
const NUMBER_PATTERN = /^([A-Z]{3})(\d{7})$/;

export function formatNumber(kind: RecordKind, n: number): string {
  if (!isRecordKind(kind)) throw new Error('unknown record kind');
  if (!Number.isInteger(n) || n < 1 || n > MAX_NUMBER) throw new Error('record number out of range');
  return `${NUMBER_PREFIX[kind]}${String(n).padStart(DIGITS, '0')}`;
}

export function parseNumber(text: string): { kind: RecordKind; n: number } | null {
  const match = typeof text === 'string' ? NUMBER_PATTERN.exec(text) : null;
  if (!match) return null;
  const kind = RECORD_KINDS.find((k) => NUMBER_PREFIX[k] === match[1]);
  const n = Number(match[2]);
  if (kind === undefined || n < 1) return null;
  return { kind, n };
}
