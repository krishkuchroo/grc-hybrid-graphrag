// @vitest-environment jsdom
// S1-008 criterion 3, who sees "Add link" (D200, D50, D7): it shows only to people who can edit
// this record, or who can edit some record type this one may link to. The web only hides the
// button; the API decides (D7, tested in errors.unit.test.tsx).
//
// Every role × record page the role can open, each person with restricted clearance so labels hide
// nothing. The Control Owner is Priya, who owns control C1; their "edit own" on controls lets them
// link their own control to a risk or a policy (canLinkRecords from @grc/shared, D200). A Control
// Owner and a Viewer can't open an incident at all (D50), so those two cells aren't pages.
//
// Expected, from the D50 table and the ontology (LINK_TYPES):
//                       risk   control  policy  asset  incident
//   admin                yes    yes      yes     yes    yes
//   risk_manager         yes    yes      no      yes    yes      (edits risks)
//   compliance_manager   yes    yes      yes     no     no       (edits controls and policies)
//   control_owner        yes    yes(own) yes     no     -        (edits their own controls)
//   auditor              no     no       no      no     no
//   analyst              yes    no       no      yes    yes      (edits incidents)
//   viewer               no     no       no      no     -
import { can, LINK_TYPES, ROLES, type RecordKind } from '@grc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  A,
  addLinkButton,
  C,
  findGroup,
  flush,
  I,
  LinksApi,
  openRecord,
  P,
  R,
  resetApp,
  withRole,
  type StoredRecord,
} from './helpers';

afterEach(resetApp);

const EXPECTED: Record<string, Partial<Record<RecordKind, boolean>>> = {
  admin: { risk: true, control: true, policy: true, asset: true, incident: true },
  risk_manager: { risk: true, control: true, policy: false, asset: true, incident: true },
  compliance_manager: { risk: true, control: true, policy: true, asset: false, incident: false },
  control_owner: { risk: true, control: true, policy: true, asset: false },
  auditor: { risk: false, control: false, policy: false, asset: false, incident: false },
  analyst: { risk: true, control: false, policy: false, asset: true, incident: true },
  viewer: { risk: false, control: false, policy: false, asset: false },
};

/** The page opened for each kind, and a group title it shows (each has a visible link). */
const PAGE: Record<RecordKind, { record: StoredRecord; group: RegExp }> = {
  risk: { record: R.ransomware, group: /^assets exposed to this risk$/i },
  control: { record: C.mfa, group: /^policies that govern it$/i },
  policy: { record: P.infosec, group: /^controls it governs$/i },
  asset: { record: A.claims, group: /^risks it is exposed to$/i },
  incident: { record: I.phishing, group: /^risks exposed$/i },
};

describe('the table above agrees with D50 and the ontology', () => {
  it('each "yes" is an edit on this kind or on a kind it links to', () => {
    for (const role of ROLES) {
      for (const [kind, expected] of Object.entries(EXPECTED[role]!) as [RecordKind, boolean][]) {
        const neighbours = LINK_TYPES.flatMap((t) => (t.from === kind ? [t.to] : t.to === kind ? [t.from] : []));
        const derived = [kind, ...neighbours].some((k) => can(role, k, 'edit', { isOwner: true }));
        expect(derived, `${role} on ${kind}`).toBe(expected);
      }
    }
  });
});

describe('"Add link" on each record page, for every role', () => {
  for (const role of ROLES) {
    for (const [kind, expected] of Object.entries(EXPECTED[role]!) as [RecordKind, boolean][]) {
      it(`${role} on a ${kind}: ${expected ? 'shows' : 'no'} "Add link"`, async () => {
        const { record, group } = PAGE[kind];
        await openRecord(record, new LinksApi({ me: withRole(role) }));
        await findGroup(group);
        await flush();
        if (expected) expect(addLinkButton(), 'an "Add link" button').not.toBeNull();
        else expect(addLinkButton(), 'no "Add link" button').toBeNull();
      });
    }
  }
});
