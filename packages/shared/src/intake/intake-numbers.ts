// Evidence and Audit findings (D202): their kinds, graph labels, API paths and numbers (D68, D196,
// D213 (1)). A number is a 3-letter prefix plus 7 digits, counted per org and per kind from the
// records' FIRST_NUMBER (1001), so the first ones are `EVD0001001` and `AUD0001001`.

export const INTAKE_RECORD_KINDS = ['evidence', 'audit_finding'] as const;

export type IntakeRecordKind = (typeof INTAKE_RECORD_KINDS)[number];

export function isIntakeRecordKind(value: unknown): value is IntakeRecordKind {
  return typeof value === 'string' && (INTAKE_RECORD_KINDS as readonly string[]).includes(value);
}

/** The Neo4j node labels (D67). */
export const INTAKE_NODE_LABELS = Object.freeze({
  evidence: 'Evidence',
  audit_finding: 'AuditFinding',
} as const satisfies Record<IntakeRecordKind, string>);

/** The names in the API paths (D47), for example `/api/v1/audit-findings`. */
export const INTAKE_PATHS = Object.freeze({
  evidence: 'evidence',
  audit_finding: 'audit-findings',
} as const satisfies Record<IntakeRecordKind, string>);

export const INTAKE_NUMBER_PREFIX = Object.freeze({
  evidence: 'EVD',
  audit_finding: 'AUD',
} as const satisfies Record<IntakeRecordKind, string>);

const DIGITS = 7;
const MAX_NUMBER = 9_999_999;
const INTAKE_NUMBER_PATTERN = /^(EVD|AUD)(\d{7})$/;

export function formatIntakeNumber(kind: IntakeRecordKind | string, n: number): string {
  if (!isIntakeRecordKind(kind)) throw new Error('unknown intake record kind');
  if (!Number.isInteger(n) || n < 1 || n > MAX_NUMBER) throw new Error('intake record number out of range');
  return `${INTAKE_NUMBER_PREFIX[kind]}${String(n).padStart(DIGITS, '0')}`;
}

/** `{ kind, n }` for an evidence or finding number, `null` for anything else (S1's prefixes included). */
export function parseIntakeNumber(text: unknown): { kind: IntakeRecordKind; n: number } | null {
  const match = typeof text === 'string' ? INTAKE_NUMBER_PATTERN.exec(text) : null;
  if (!match) return null;
  const kind = INTAKE_RECORD_KINDS.find((k) => INTAKE_NUMBER_PREFIX[k] === match[1]);
  const n = Number(match[2]);
  if (kind === undefined || n < 1) return null;
  return { kind, n };
}
