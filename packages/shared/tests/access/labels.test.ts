// M0-008 criteria 2 and 4 (D23, D51, D59): all 16 clearance x label pairs, the label defaults and
// the raise/lower rule.
import { describe, expect, it } from 'vitest';
import { EXPECTED_VISIBLE, LABELS, ROLES, type Label, type Role } from './expected.js';
import { loadAccess } from './load.js';

const PAIRS: [Label, Label, boolean][] = LABELS.flatMap((clearance) =>
  LABELS.map((label) => [clearance, label, EXPECTED_VISIBLE[clearance][label]] as [Label, Label, boolean]),
);

describe('criterion 2: isVisible for every clearance x label pair', () => {
  it('covers 16 pairs', () => {
    expect(PAIRS).toHaveLength(16);
  });

  it.each(PAIRS)('clearance %s, label %s -> %s', async (clearance, label, expected) => {
    const { isVisible } = await loadAccess();
    expect(isVisible(clearance, label)).toBe(expected);
  });

  it.each([
    ['an unknown clearance', 'top_secret', 'public'],
    ['an unknown label', 'restricted', 'secret'],
    ['an empty clearance', '', 'public'],
  ])('refuses %s (fail safe)', async (_what, clearance, label) => {
    const { isVisible } = await loadAccess();
    expect(isVisible(clearance, label)).toBe(false);
  });
});

describe('criterion 4: default labels (D51)', () => {
  it.each(LABELS)('an asset takes its data classification (%s)', async (label) => {
    const { defaultLabel } = await loadAccess();
    expect(defaultLabel('asset', { dataClassification: label })).toBe(label);
  });

  it('an asset without a data classification is internal', async () => {
    const { defaultLabel } = await loadAccess();
    expect(defaultLabel('asset')).toBe('internal');
    expect(defaultLabel('asset', {})).toBe('internal');
  });

  it.each(['incident', 'evidence'])('%s is confidential', async (type) => {
    const { defaultLabel } = await loadAccess();
    expect(defaultLabel(type)).toBe('confidential');
  });

  it.each(['risk', 'control', 'policy', 'framework_mapping', 'audit_finding'])('%s is internal', async (type) => {
    const { defaultLabel } = await loadAccess();
    expect(defaultLabel(type)).toBe('internal');
  });
});

// "Editors can raise a label. Only an Admin can lower one." An editor is a role that can edit some
// record type in D50 (edit or edit_own): every role except viewer.
const EDITORS: Role[] = ['admin', 'risk_manager', 'compliance_manager', 'control_owner', 'auditor', 'analyst'];

const rank = (label: Label) => LABELS.indexOf(label);
const CHANGES: [Role, Label, Label, boolean][] = ROLES.flatMap((role) =>
  LABELS.flatMap((from) =>
    LABELS.filter((to) => to !== from).map((to) => {
      const raise = rank(to) > rank(from);
      const expected = raise ? EDITORS.includes(role) : role === 'admin';
      return [role, from, to, expected] as [Role, Label, Label, boolean];
    }),
  ),
);

describe('criterion 4: canChangeLabel, editors raise and only admin lowers (D51)', () => {
  it('covers 7 roles x 12 ordered label changes', () => {
    expect(CHANGES).toHaveLength(84);
  });

  it.each(CHANGES)('%s changing %s -> %s: %s', async (role, from, to, expected) => {
    const { canChangeLabel } = await loadAccess();
    expect(canChangeLabel(role, from, to)).toBe(expected);
  });

  it('refuses an unknown role', async () => {
    const { canChangeLabel } = await loadAccess();
    expect(canChangeLabel('superuser', 'restricted', 'public')).toBe(false);
    expect(canChangeLabel('superuser', 'public', 'restricted')).toBe(false);
  });
});
