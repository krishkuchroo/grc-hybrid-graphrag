// The role x record-type table (D50), written once here and used by the API guard and, later, the
// web app. "Own" means only the records assigned to that user. Anything unknown (role, subject or
// action) is refused (fail safe, principle 7).
import { ROLES, isRole, type Role } from './roles.js';

export const RECORD_TYPES = [
  'asset',
  'risk',
  'control',
  'policy',
  'incident',
  'framework_mapping',
  'evidence',
  'audit_finding',
] as const;
export const FUNCTIONS = ['uploads', 'review_queue', 'audit_trail', 'admin', 'chat'] as const;
export const ACTIONS = ['view', 'edit', 'approve', 'work', 'upload', 'use'] as const;

export type RecordType = (typeof RECORD_TYPES)[number];
export type AccessFunction = (typeof FUNCTIONS)[number];
export type Subject = RecordType | AccessFunction;
export type Action = (typeof ACTIONS)[number];
export type Cell = 'edit' | 'view' | 'edit_own' | 'upload_own' | 'approve' | 'work' | 'yes' | 'evidence_only' | 'none';

export interface AccessCtx {
  isOwner?: boolean;
  recordType?: string;
}

type Row = readonly [Cell, Cell, Cell, Cell, Cell, Cell, Cell];

// Column order: admin, risk_manager, compliance_manager, control_owner, auditor, analyst, viewer.
const ROWS: Record<Subject, Row> = {
  asset: ['edit', 'view', 'view', 'view', 'view', 'view', 'view'],
  risk: ['edit', 'edit', 'view', 'view', 'view', 'view', 'view'],
  control: ['edit', 'view', 'edit', 'edit_own', 'view', 'view', 'view'],
  policy: ['edit', 'view', 'edit', 'view', 'view', 'view', 'view'],
  incident: ['edit', 'view', 'view', 'none', 'view', 'edit', 'none'],
  framework_mapping: ['edit', 'view', 'edit', 'view', 'view', 'approve', 'view'],
  evidence: ['edit', 'view', 'view', 'upload_own', 'view', 'view', 'none'],
  audit_finding: ['view', 'view', 'view', 'view', 'edit', 'view', 'none'],
  uploads: ['yes', 'yes', 'yes', 'evidence_only', 'none', 'yes', 'none'],
  review_queue: ['view', 'none', 'none', 'none', 'none', 'work', 'none'],
  audit_trail: ['view', 'none', 'none', 'none', 'view', 'none', 'none'],
  admin: ['edit', 'none', 'none', 'none', 'none', 'none', 'none'],
  chat: ['yes', 'yes', 'yes', 'yes', 'yes', 'yes', 'yes'],
};

function buildRow(cells: Row): Readonly<Record<Role, Cell>> {
  return Object.freeze(Object.fromEntries(ROLES.map((role, i) => [role, cells[i]])) as Record<Role, Cell>);
}

/** `ROLE_TABLE[subject][role]` is the D50 cell. */
export const ROLE_TABLE: Readonly<Record<Subject, Readonly<Record<Role, Cell>>>> = Object.freeze(
  Object.fromEntries(Object.entries(ROWS).map(([subject, cells]) => [subject, buildRow(cells)])) as Record<
    Subject,
    Record<Role, Cell>
  >,
);

export function isSubject(value: unknown): value is Subject {
  return typeof value === 'string' && Object.hasOwn(ROLE_TABLE, value);
}

/** Whether `role` may do `action` on `subject`. `edit_own` and `upload_own` need `ctx.isOwner`,
 * and `evidence_only` needs `ctx.recordType === 'evidence'`. */
export function can(role: string, subject: string, action: Action | string, ctx?: AccessCtx): boolean {
  if (!isRole(role) || !isSubject(subject)) return false;
  const cell = ROLE_TABLE[subject][role];
  const owner = ctx?.isOwner === true;
  switch (cell) {
    case 'view':
      return action === 'view';
    case 'edit':
      return action === 'view' || action === 'edit';
    case 'approve':
      return action === 'view' || action === 'approve';
    case 'work':
      return action === 'view' || action === 'work';
    case 'edit_own':
      return owner && (action === 'view' || action === 'edit');
    case 'upload_own':
      return owner && (action === 'view' || action === 'upload');
    case 'yes':
      return action === 'use';
    case 'evidence_only':
      return action === 'use' && ctx?.recordType === 'evidence';
    default:
      return false;
  }
}

/** An editor is a role that can edit some record type (`edit` or `edit_own`). */
export function isEditor(role: string): boolean {
  if (!isRole(role)) return false;
  return RECORD_TYPES.some((type) => {
    const cell = ROLE_TABLE[type][role];
    return cell === 'edit' || cell === 'edit_own';
  });
}
