// The expected access rules for M0-008, written out by hand from memory.md (D50, D51) and NOT
// imported from src, so the tests check the code against the decision rather than against itself.
//
// Contract these tests hold the builder to (TASKS.md, M0-008 "Interfaces"):
// - `packages/shared/src/access/index.ts` exports ROLES, LABELS (low to high), RECORD_TYPES,
//   FUNCTIONS, ROLE_TABLE, can, isVisible, isLinkVisible, defaultLabel and canChangeLabel, and
//   `packages/shared/src/index.ts` re-exports them (so other packages import them from `@grc/shared`).
// - `ROLE_TABLE[subject][role]` is the D50 cell, where subject is a record type or a function.
// - `isLinkVisible(viewer, from, to)` takes `viewer = { role, clearance }` and each end as
//   `{ recordType, label, isOwner? }`.
//
// How a cell answers each action of `can(role, subject, action, ctx)`. D50 names each cell with
// one verb; the reading below is the plain, least-privilege one (fail safe, principle 7):
// - `none`          : nothing.
// - `view`          : view.
// - `edit`          : view and edit.
// - `approve`       : view and approve.
// - `work`          : view and work.
// - `edit_own`      : view and edit, but only with `ctx.isOwner === true`. "Own means only the
//                     records assigned to that user" (D50), so the whole cell is limited to own records.
// - `upload_own`    : view and upload, only with `ctx.isOwner === true`.
// - `yes`           : use.
// - `evidence_only` : use, only with `ctx.recordType === 'evidence'`.
// Anything else (unknown role, subject or action) is refused.

export const ROLES = [
  'admin',
  'risk_manager',
  'compliance_manager',
  'control_owner',
  'auditor',
  'analyst',
  'viewer',
] as const;
export const LABELS = ['public', 'internal', 'confidential', 'restricted'] as const;
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
export const CELLS = [
  'edit',
  'view',
  'edit_own',
  'upload_own',
  'approve',
  'work',
  'yes',
  'evidence_only',
  'none',
] as const;

export type Role = (typeof ROLES)[number];
export type Label = (typeof LABELS)[number];
export type RecordType = (typeof RECORD_TYPES)[number];
export type Subject = RecordType | (typeof FUNCTIONS)[number];
export type Action = (typeof ACTIONS)[number];
export type Cell = (typeof CELLS)[number];
export interface Ctx {
  isOwner?: boolean;
  recordType?: string;
}

// D50, row by row. Column order: admin, risk_manager, compliance_manager, control_owner, auditor,
// analyst, viewer. "—" in memory.md is `none`.
const ROWS: Record<Subject, readonly Cell[]> = {
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

export const SUBJECTS = [...RECORD_TYPES, ...FUNCTIONS] as Subject[];

export const EXPECTED_TABLE: Record<Subject, Record<Role, Cell>> = Object.fromEntries(
  SUBJECTS.map((subject) => [subject, Object.fromEntries(ROLES.map((role, i) => [role, ROWS[subject][i]]))]),
) as Record<Subject, Record<Role, Cell>>;

export function expectedCan(cell: Cell, action: Action, ctx?: Ctx): boolean {
  const owner = ctx?.isOwner === true;
  switch (cell) {
    case 'none':
      return false;
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
  }
}

// The ctx variants every cell is asked about, so ownership and the evidence-only rule are checked
// both ways.
export const CTX_VARIANTS: { name: string; ctx: Ctx | undefined }[] = [
  { name: 'no ctx', ctx: undefined },
  { name: 'empty ctx', ctx: {} },
  { name: 'owner', ctx: { isOwner: true } },
  { name: 'not owner', ctx: { isOwner: false } },
  { name: 'recordType evidence', ctx: { recordType: 'evidence' } },
  { name: 'recordType risk', ctx: { recordType: 'risk' } },
  { name: 'owner + recordType evidence', ctx: { isOwner: true, recordType: 'evidence' } },
  { name: 'not owner + recordType evidence', ctx: { isOwner: false, recordType: 'evidence' } },
];

// D51: visible when the clearance is at or above the label. Rows are clearances, columns labels.
export const EXPECTED_VISIBLE: Record<Label, Record<Label, boolean>> = {
  public: { public: true, internal: false, confidential: false, restricted: false },
  internal: { public: true, internal: true, confidential: false, restricted: false },
  confidential: { public: true, internal: true, confidential: true, restricted: false },
  restricted: { public: true, internal: true, confidential: true, restricted: true },
};
