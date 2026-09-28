// M0-008 criterion 1 (D10, D50, D59): every one of the 13 x 7 = 91 D50 cells gives the expected
// answer for every action, including `edit_own` and `upload_own` with and without ownership, and
// `evidence_only` with and without an evidence record type. The expected table is in expected.ts.
import { describe, expect, it } from 'vitest';
import {
  ACTIONS,
  CTX_VARIANTS,
  EXPECTED_TABLE,
  FUNCTIONS,
  LABELS,
  RECORD_TYPES,
  ROLES,
  SUBJECTS,
  expectedCan,
  type Role,
  type Subject,
} from './expected.js';
import { EXPORTS, loadAccess, loadModule } from './load.js';

describe('names shared across tasks (TASKS.md M0 shared notes, D10, D51)', () => {
  it('ROLES are the 7 D10 roles, in order', async () => {
    const { ROLES: actual } = await loadAccess();
    expect([...actual]).toEqual([...ROLES]);
  });

  it('LABELS are ordered low to high', async () => {
    const { LABELS: actual } = await loadAccess();
    expect([...actual]).toEqual([...LABELS]);
  });

  it('RECORD_TYPES are the 8 record rows of D50', async () => {
    const { RECORD_TYPES: actual } = await loadAccess();
    expect([...actual]).toEqual([...RECORD_TYPES]);
  });

  it('FUNCTIONS are the 5 function rows of D50', async () => {
    const { FUNCTIONS: actual } = await loadAccess();
    expect([...actual]).toEqual([...FUNCTIONS]);
  });

  it('@grc/shared (src/index.ts) re-exports the access rules', async () => {
    const root = await loadModule('src/index.ts');
    for (const name of EXPORTS) expect(root[name], `src/index.ts export ${name}`).toBeDefined();
  });
});

describe('ROLE_TABLE is exactly the D50 table', () => {
  it('has exactly the 13 subjects as rows', async () => {
    const { ROLE_TABLE } = await loadAccess();
    expect(Object.keys(ROLE_TABLE).sort()).toEqual([...SUBJECTS].sort());
  });

  it.each(SUBJECTS)('row %s has exactly the 7 roles and the D50 cells', async (subject) => {
    const { ROLE_TABLE } = await loadAccess();
    const row = ROLE_TABLE[subject];
    expect(row, `ROLE_TABLE.${subject}`).toBeDefined();
    expect(Object.keys(row!).sort()).toEqual([...ROLES].sort());
    expect({ ...row }).toEqual(EXPECTED_TABLE[subject]);
  });
});

const CELLS_91: [Subject, Role][] = SUBJECTS.flatMap((subject) =>
  ROLES.map((role) => [subject, role] as [Subject, Role]),
);

describe('can(): every D50 cell, every action, with and without ownership', () => {
  it('covers 91 cells', () => {
    expect(CELLS_91).toHaveLength(91);
  });

  it.each(CELLS_91)('%s x %s', async (subject, role) => {
    const { can } = await loadAccess();
    const cell = EXPECTED_TABLE[subject][role];
    const wrong: string[] = [];
    for (const action of ACTIONS) {
      for (const { name, ctx } of CTX_VARIANTS) {
        const expected = expectedCan(cell, action, ctx);
        const actual = can(role, subject, action, ctx);
        if (actual !== expected) wrong.push(`${action} (${name}): expected ${expected}, got ${String(actual)}`);
      }
    }
    expect(wrong, `cell "${cell}" for ${role} on ${subject}`).toEqual([]);
  });
});

describe('can(): ownership cells, spelled out', () => {
  it('a control owner edits a control assigned to them', async () => {
    const { can } = await loadAccess();
    expect(can('control_owner', 'control', 'edit', { isOwner: true })).toBe(true);
  });

  it('a control owner cannot edit a control assigned to someone else', async () => {
    const { can } = await loadAccess();
    expect(can('control_owner', 'control', 'edit', { isOwner: false })).toBe(false);
    expect(can('control_owner', 'control', 'edit')).toBe(false);
  });

  it('a control owner uploads evidence for their own records only', async () => {
    const { can } = await loadAccess();
    expect(can('control_owner', 'evidence', 'upload', { isOwner: true })).toBe(true);
    expect(can('control_owner', 'evidence', 'upload', { isOwner: false })).toBe(false);
    expect(can('control_owner', 'evidence', 'edit', { isOwner: true })).toBe(false);
  });

  it('a control owner may use uploads for evidence only', async () => {
    const { can } = await loadAccess();
    expect(can('control_owner', 'uploads', 'use', { recordType: 'evidence' })).toBe(true);
    expect(can('control_owner', 'uploads', 'use', { recordType: 'policy' })).toBe(false);
    expect(can('control_owner', 'uploads', 'use')).toBe(false);
  });
});

describe('can(): fails safe on unknown input (principle 7)', () => {
  it.each([
    ['an unknown role', 'superuser', 'risk', 'view'],
    ['an empty role', '', 'risk', 'view'],
    ['an unknown subject', 'admin', 'payroll', 'view'],
    ['an unknown action', 'admin', 'risk', 'delete'],
    ['a prototype key as subject', 'admin', '__proto__', 'view'],
    ['a prototype key as role', 'constructor', 'risk', 'view'],
  ])('refuses %s', async (_what, role, subject, action) => {
    const { can } = await loadAccess();
    expect(can(role, subject, action, { isOwner: true, recordType: 'evidence' })).toBe(false);
  });
});
