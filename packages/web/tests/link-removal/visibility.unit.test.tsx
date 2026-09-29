// @vitest-environment jsdom
// S1-012 criterion 1, who sees "Remove" (D200, D201, D207, D7): a row shows it only when
// `canLinkRecords(person, this record, the other record)` holds and the link's origin is `manual`
// or `import` (`isRemovableLinkOrigin`). A Viewer never sees it; nobody sees it on an `ai` link,
// Admins included. The web only hides the button; the API decides (errors.unit.test.tsx).
//
// The fixed records and links are S1-008's (tests/record-links/helpers.tsx). Expected cells, from
// D50 (`ROLE_TABLE`) and D51:
// - Risk Manager Dana (confidential) edits risks: every row on risk R1 page; on control C1's page
//   only the risk row (she edits the risk end), not the policy row (she edits neither end).
// - Viewer Vic edits nothing: no "Remove" anywhere.
// - Control Owner Priya (confidential) owns C1 and C3 and edits only those: on C1's page both
//   rows; on R1's page only C1's row; a control she doesn't own (C2) is hidden from her (edit_own),
//   so its page shows no "Remove".
import { canLinkRecords, isRemovableLinkOrigin } from '@grc/shared';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  A,
  ADMIN,
  allRemoveButtons,
  C,
  CONTROL_OWNER,
  findGroup,
  flush,
  I,
  link,
  LinksApi,
  openRecord,
  P,
  R,
  removeButtonIn,
  renderApp,
  resetApp,
  RISK_MANAGER,
  VIEWER,
  type StoredRecord,
} from './helpers';

afterEach(resetApp);

const RISK_ASSETS = /^assets exposed to this risk$/i;
const RISK_CONTROLS = /^controls that treat this risk$/i;
const RISK_INCIDENTS = /^incidents that exposed this risk$/i;
const CONTROL_RISKS = /^risks it treats$/i;
const CONTROL_POLICIES = /^policies that govern it$/i;
const POLICY_CONTROLS = /^controls it governs$/i;

async function expectRemove(title: RegExp, other: StoredRecord): Promise<void> {
  const group = await findGroup(title);
  await waitFor(() => expect(removeButtonIn(group, other), `"Remove" on ${other.number}`).not.toBeNull());
}

async function expectNoRemove(title: RegExp, other: StoredRecord): Promise<void> {
  const group = await findGroup(title);
  expect(removeButtonIn(group, other), `no "Remove" on ${other.number}`).toBeNull();
}

describe('the expected cells agree with canLinkRecords and D207', () => {
  const who = (m: { id: string; role: string; clearance: string }) => ({
    userId: m.id,
    role: m.role,
    clearance: m.clearance,
  });
  it('Risk Manager: yes on R1–C1, yes on R1–A1, no on C1–P1', () => {
    expect(canLinkRecords(who(RISK_MANAGER), R.ransomware, C.mfa)).toBe(true);
    expect(canLinkRecords(who(RISK_MANAGER), A.claims, R.ransomware)).toBe(true);
    expect(canLinkRecords(who(RISK_MANAGER), C.mfa, P.infosec)).toBe(false);
  });
  it('Control Owner: yes on their own C1, no on A1–R1', () => {
    expect(canLinkRecords(who(CONTROL_OWNER), R.ransomware, C.mfa)).toBe(true);
    expect(canLinkRecords(who(CONTROL_OWNER), C.mfa, P.infosec)).toBe(true);
    expect(canLinkRecords(who(CONTROL_OWNER), A.claims, R.ransomware)).toBe(false);
  });
  it('Viewer: never', () => {
    expect(canLinkRecords(who(VIEWER), A.claims, R.ransomware)).toBe(false);
    expect(canLinkRecords(who(VIEWER), R.ransomware, C.review)).toBe(false);
  });
  it('origins: manual and import only', () => {
    expect(['manual', 'import', 'ai'].map(isRemovableLinkOrigin)).toEqual([true, true, false]);
  });
});

describe('an editor of this record (Risk Manager on a risk)', () => {
  it('sees "Remove" on every row they can see', async () => {
    await openRecord(R.ransomware, new LinksApi({ me: RISK_MANAGER }));
    await expectRemove(RISK_ASSETS, A.claims);
    await expectRemove(RISK_CONTROLS, C.mfa);
    await expectRemove(RISK_CONTROLS, C.review);
    await expectRemove(RISK_INCIDENTS, I.phishing);
  });
});

describe('an editor of only the other end (Risk Manager on a control page)', () => {
  it('sees "Remove" on the risk row but not on the policy row', async () => {
    await openRecord(C.mfa, new LinksApi({ me: RISK_MANAGER }));
    await expectRemove(CONTROL_RISKS, R.ransomware);
    await expectNoRemove(CONTROL_POLICIES, P.infosec);
  });
});

describe('a Viewer', () => {
  it('never sees "Remove" on a risk page', async () => {
    await openRecord(R.ransomware, new LinksApi({ me: VIEWER }));
    await findGroup(RISK_ASSETS);
    await flush();
    await expectNoRemove(RISK_ASSETS, A.claims);
    await expectNoRemove(RISK_CONTROLS, C.review);
    expect(allRemoveButtons()).toHaveLength(0);
  });

  it('never sees "Remove" on an asset page', async () => {
    await openRecord(A.claims, new LinksApi({ me: VIEWER }));
    await findGroup(/^risks it is exposed to$/i);
    await flush();
    expect(allRemoveButtons()).toHaveLength(0);
  });
});

describe('a Control Owner', () => {
  it('on a control they own: "Remove" on the risk row and the policy row', async () => {
    await openRecord(C.mfa, new LinksApi({ me: CONTROL_OWNER }));
    await expectRemove(CONTROL_RISKS, R.ransomware);
    await expectRemove(CONTROL_POLICIES, P.infosec);
  });

  it('on a risk: "Remove" only on the row of the control they own', async () => {
    await openRecord(R.ransomware, new LinksApi({ me: CONTROL_OWNER }));
    await expectRemove(RISK_CONTROLS, C.mfa);
    await expectNoRemove(RISK_ASSETS, A.claims);
    expect(allRemoveButtons()).toHaveLength(1);
  });

  it('on a policy governing an owned and a not-owned control: only the owned one shows, with "Remove"', async () => {
    const links = [link('GOVERNED_BY', C.mfa, P.infosec), link('GOVERNED_BY', C.review, P.infosec)];
    await openRecord(P.infosec, new LinksApi({ me: CONTROL_OWNER, links }));
    await expectRemove(POLICY_CONTROLS, C.mfa);
    expect(allRemoveButtons()).toHaveLength(1);
  });

  it('on a control they don’t own: the page is not found and nothing can be removed', async () => {
    const api = new LinksApi({ me: CONTROL_OWNER });
    renderApp(`/controls/${C.review.id}`, api);
    await screen.findByText(/doesn.t exist or you can.t see it/i);
    await flush();
    expect(allRemoveButtons()).toHaveLength(0);
    expect(api.removeLinkCalls()).toHaveLength(0);
  });
});

describe('AI links never show "Remove" (D207)', () => {
  it('an Admin on a group with a manual, an import and an ai row sees "Remove" on the first two only', async () => {
    const links = [
      link('MITIGATED_BY', R.ransomware, C.mfa, 'manual'),
      link('MITIGATED_BY', R.ransomware, C.review, 'import'),
      link('MITIGATED_BY', R.ransomware, C.vault, 'ai'),
    ];
    await openRecord(R.ransomware, new LinksApi({ me: ADMIN, links }));
    await expectRemove(RISK_CONTROLS, C.mfa);
    await expectRemove(RISK_CONTROLS, C.review);
    await expectNoRemove(RISK_CONTROLS, C.vault);
  });

  it('an Admin on an asset: the ai HOSTS row has no "Remove", the import RUNS row has one', async () => {
    const links = [link('HOSTS', A.claims, A.claimsApp, 'ai'), link('RUNS', A.claims, A.billing, 'import')];
    await openRecord(A.claims, new LinksApi({ me: ADMIN, links }));
    const runs = await findGroup(/^runs( \/ runs on)?$/i);
    await waitFor(() => expect(removeButtonIn(runs, A.billing)).not.toBeNull());
    const hosts = await findGroup(/^hosts( \/ hosted by)?$/i);
    expect(removeButtonIn(hosts, A.claimsApp)).toBeNull();
  });

  it('a Risk Manager who edits the risk sees no "Remove" on its ai row', async () => {
    const links = [
      link('EXPOSED_TO', A.claims, R.ransomware, 'manual'),
      link('MITIGATED_BY', R.ransomware, C.mfa, 'ai'),
    ];
    await openRecord(R.ransomware, new LinksApi({ me: RISK_MANAGER, links }));
    await expectRemove(RISK_ASSETS, A.claims);
    await expectNoRemove(RISK_CONTROLS, C.mfa);
  });
});
