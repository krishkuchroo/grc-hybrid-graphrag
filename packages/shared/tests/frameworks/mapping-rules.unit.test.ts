// S2-001 criterion 7 (D50 "Framework mappings" row, D51, D212 (3), D45.7): who may add or remove a
// control-to-requirement mapping. True only for Admin and Compliance Manager (the row's `edit`
// cell), and only for a control whose label is at or below their clearance. Owning the control
// grants nothing: a Control Owner is false even on their own control (the Framework-mappings row
// wins over D200's owner rule), and the Analyst's `approve` cell is not a mapping right in S2.
//
// Agrees with S1-005's `canLinkRecords` tests (packages/api/tests/links/rules.unit.test.ts and
// packages/web/tests/record-links/) on the caller shape `{ userId, role, clearance }`, the ownership
// reading (`owner === userId`) and fail safe on anything unknown, and deliberately differs where
// D212 (3) says so: `canLinkRecords` lets a Control Owner link their own control; `canMapControl`
// never does.
import { describe, expect, it } from 'vitest';
import { LABELS, MAPPERS, ROLES, atOrBelow } from './expected.js';
import { loadFrameworks, loadModule } from './load.js';

const ME = 'user-me';
const SOMEONE_ELSE = 'user-other';

const EVERY_CASE = ROLES.flatMap((role) =>
  LABELS.flatMap((clearance) =>
    LABELS.flatMap((label) =>
      [true, false].map((owns) => ({
        role,
        clearance,
        label,
        owns,
        expected: MAPPERS.includes(role) && atOrBelow(label, clearance),
      })),
    ),
  ),
);

describe('criterion 7: the mappers are the editors in the D50 Framework-mappings row', () => {
  // Ties this file's hand-written MAPPERS to the one role table every task reads
  // (tests/access/role-table.unit.test.ts checks that table against D50), so the two can't drift.
  it('MAPPERS is exactly the roles whose framework_mapping cell is edit', async () => {
    const access = await loadModule('src/access/index.ts');
    const table = access.ROLE_TABLE as Record<string, Record<string, string>>;
    const editors = ROLES.filter((role) => table.framework_mapping![role] === 'edit');
    expect(editors).toEqual([...MAPPERS]);
  });
});

describe('criterion 7: canMapControl over every role x clearance x label x ownership', () => {
  it(`covers ${ROLES.length} roles x ${LABELS.length} clearances x ${LABELS.length} labels x 2 (${EVERY_CASE.length} cases)`, () => {
    expect(EVERY_CASE).toHaveLength(7 * 4 * 4 * 2);
  });

  it.each(EVERY_CASE)(
    '$role, clearance $clearance, control label $label, owns it: $owns -> $expected',
    async ({ role, clearance, label, owns, expected }) => {
      const { canMapControl } = await loadFrameworks();
      const caller = { userId: ME, role, clearance };
      const control = { label, owner: owns ? ME : SOMEONE_ELSE };
      expect(canMapControl(caller, control)).toBe(expected);
    },
  );
});

describe('criterion 7: the rule, case by case', () => {
  it.each(LABELS)('a Control Owner cleared %s cannot map a control they own, at any label', async (clearance) => {
    const { canMapControl } = await loadFrameworks();
    for (const label of LABELS) {
      expect(canMapControl({ userId: ME, role: 'control_owner', clearance }, { label, owner: ME }), label).toBe(false);
    }
  });

  it.each(LABELS)('an Analyst cleared %s cannot map (approve is not a mapping right in S2)', async (clearance) => {
    const { canMapControl } = await loadFrameworks();
    for (const label of LABELS) {
      for (const owner of [ME, SOMEONE_ELSE]) {
        expect(canMapControl({ userId: ME, role: 'analyst', clearance }, { label, owner })).toBe(false);
      }
    }
  });

  it.each(MAPPERS)('%s cannot map a control above their clearance', async (role) => {
    const { canMapControl } = await loadFrameworks();
    expect(canMapControl({ userId: ME, role, clearance: 'internal' }, { label: 'confidential', owner: ME })).toBe(
      false,
    );
    expect(canMapControl({ userId: ME, role, clearance: 'public' }, { label: 'restricted', owner: SOMEONE_ELSE })).toBe(
      false,
    );
  });

  it.each(MAPPERS)('%s can map a control they do not own, at or below their clearance', async (role) => {
    const { canMapControl } = await loadFrameworks();
    expect(
      canMapControl({ userId: ME, role, clearance: 'confidential' }, { label: 'confidential', owner: SOMEONE_ELSE }),
    ).toBe(true);
    expect(
      canMapControl({ userId: ME, role, clearance: 'confidential' }, { label: 'public', owner: SOMEONE_ELSE }),
    ).toBe(true);
  });
});

describe('criterion 7: anything unknown is false (fail safe, D45.7)', () => {
  const GOOD_CALLER = { userId: ME, role: 'admin', clearance: 'restricted' };
  const GOOD_CONTROL = { label: 'public', owner: SOMEONE_ELSE };

  it('the good case is true (so the refusals below are about the unknown value)', async () => {
    const { canMapControl } = await loadFrameworks();
    expect(canMapControl(GOOD_CALLER, GOOD_CONTROL)).toBe(true);
  });

  it.each([
    'superuser',
    'Admin',
    'ADMIN',
    'compliance-manager',
    '',
    ' admin',
    'toString',
    '__proto__',
    null,
    undefined,
    1,
  ])('an unknown role %j', async (role) => {
    const { canMapControl } = await loadFrameworks();
    expect(canMapControl({ ...GOOD_CALLER, role }, GOOD_CONTROL)).toBe(false);
  });

  it.each(['secret', 'Restricted', 'top_secret', '', 'toString', null, undefined, 3])(
    'an unknown clearance %j',
    async (clearance) => {
      const { canMapControl } = await loadFrameworks();
      expect(canMapControl({ ...GOOD_CALLER, clearance }, GOOD_CONTROL)).toBe(false);
    },
  );

  it.each(['secret', 'Public', 'unclassified', '', 'toString', null, undefined, 0])(
    'an unknown control label %j',
    async (label) => {
      const { canMapControl } = await loadFrameworks();
      expect(canMapControl(GOOD_CALLER, { ...GOOD_CONTROL, label })).toBe(false);
    },
  );

  it.each(['superuser', 'secret'])('an unknown value never becomes true through ownership (%s)', async (bad) => {
    const { canMapControl } = await loadFrameworks();
    expect(canMapControl({ userId: ME, role: bad, clearance: 'restricted' }, { label: 'public', owner: ME })).toBe(
      false,
    );
    expect(canMapControl({ userId: ME, role: 'admin', clearance: bad }, { label: 'public', owner: ME })).toBe(false);
  });

  it('a missing caller or control is false, not a crash', async () => {
    const { canMapControl } = await loadFrameworks();
    const call = canMapControl as unknown as (caller: unknown, control: unknown) => boolean;
    expect(call(undefined, GOOD_CONTROL)).toBe(false);
    expect(call(GOOD_CALLER, undefined)).toBe(false);
    expect(call(null, null)).toBe(false);
  });
});
