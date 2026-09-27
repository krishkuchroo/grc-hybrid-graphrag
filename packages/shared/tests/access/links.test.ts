// M0-008 criterion 3 (D51): a link is visible only when both ends are visible, each by type (the
// D50 table, with ownership) and by label (clearance at or above the label).
import { describe, expect, it } from 'vitest';
import {
  EXPECTED_TABLE,
  EXPECTED_VISIBLE,
  LABELS,
  RECORD_TYPES,
  ROLES,
  expectedCan,
  type Label,
  type RecordType,
  type Role,
} from './expected.js';
import { loadAccess, type LinkEnd } from './load.js';

function endVisible(role: Role, clearance: Label, end: LinkEnd): boolean {
  const cell = EXPECTED_TABLE[end.recordType as RecordType][role];
  return expectedCan(cell, 'view', { isOwner: end.isOwner }) && EXPECTED_VISIBLE[clearance][end.label];
}

describe('criterion 3: isLinkVisible', () => {
  it('hides a link when one end is above the viewer clearance', async () => {
    const { isLinkVisible } = await loadAccess();
    const viewer = { role: 'risk_manager', clearance: 'internal' as Label };
    const risk: LinkEnd = { recordType: 'risk', label: 'internal' };
    const asset: LinkEnd = { recordType: 'asset', label: 'restricted' };
    expect(isLinkVisible(viewer, risk, asset)).toBe(false);
    expect(isLinkVisible(viewer, asset, risk)).toBe(false);
  });

  it('hides a link when one end is a type the role cannot see', async () => {
    const { isLinkVisible } = await loadAccess();
    const viewer = { role: 'viewer', clearance: 'restricted' as Label };
    const asset: LinkEnd = { recordType: 'asset', label: 'public' };
    const incident: LinkEnd = { recordType: 'incident', label: 'public' };
    expect(isLinkVisible(viewer, incident, asset)).toBe(false);
    expect(isLinkVisible(viewer, asset, incident)).toBe(false);
  });

  it('shows a link when both ends are visible', async () => {
    const { isLinkVisible } = await loadAccess();
    const viewer = { role: 'viewer', clearance: 'internal' as Label };
    const risk: LinkEnd = { recordType: 'risk', label: 'internal' };
    const asset: LinkEnd = { recordType: 'asset', label: 'public' };
    expect(isLinkVisible(viewer, asset, risk)).toBe(true);
  });

  it('uses ownership for a control owner end', async () => {
    const { isLinkVisible } = await loadAccess();
    const viewer = { role: 'control_owner', clearance: 'internal' as Label };
    const risk: LinkEnd = { recordType: 'risk', label: 'internal' };
    expect(isLinkVisible(viewer, risk, { recordType: 'control', label: 'internal', isOwner: true })).toBe(true);
    expect(isLinkVisible(viewer, risk, { recordType: 'control', label: 'internal', isOwner: false })).toBe(false);
  });

  it('matches the rule for every role, clearance and pair of ends (type x label x ownership)', async () => {
    const { isLinkVisible } = await loadAccess();
    const ends: LinkEnd[] = RECORD_TYPES.flatMap((recordType) =>
      LABELS.flatMap((label) => [
        { recordType, label },
        { recordType, label, isOwner: true },
      ]),
    );
    const wrong: string[] = [];
    let checked = 0;
    for (const role of ROLES) {
      for (const clearance of LABELS) {
        for (const from of ends) {
          for (const to of ends) {
            const expected = endVisible(role, clearance, from) && endVisible(role, clearance, to);
            const actual = isLinkVisible({ role, clearance }, from, to);
            checked++;
            if (actual !== expected && wrong.length < 20) {
              wrong.push(
                `${role}/${clearance}: ${JSON.stringify(from)} -> ${JSON.stringify(to)}: expected ${expected}`,
              );
            }
          }
        }
      }
    }
    expect(checked).toBe(7 * 4 * 64 * 64);
    expect(wrong).toEqual([]);
  });
});
