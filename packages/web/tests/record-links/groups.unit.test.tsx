// @vitest-environment jsdom
// S1-008 criterion 1: each record page shows its links grouped with plain titles, each row showing
// the other end's number (a link to its page), name, label and status.
// - Risk: "Assets exposed to this risk" (EXPOSED_TO in), "Controls that treat this risk"
//   (MITIGATED_BY out), "Incidents that exposed this risk" (EXPOSES in).
// - Control: "Risks it treats" (MITIGATED_BY in), "Policies that govern it" (GOVERNED_BY out).
// - Policy: "Controls it governs" (GOVERNED_BY in).
// - Asset: "Hosts / Hosted by", "Runs / Runs on", "Risks it is exposed to" (EXPOSED_TO out),
//   "Incidents that impacted it" (IMPACTS in).
// - Incident: "Assets impacted" (IMPACTS out), "Risks exposed" (EXPOSES out).
// The groups follow the spec's six links (LINK_TYPES in @grc/shared, S1-001) and S1-005's
// GET …/:id/links answer (`type`, `direction`, `other`). The Admin (restricted clearance) sees every
// end here, so every link shows.
import { screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  A,
  C,
  expectRow,
  findGroup,
  I,
  LinksApi,
  numbersIn,
  openRecord,
  P,
  PAGE_PATHS,
  queryGroup,
  R,
  resetApp,
  rowFor,
  type StoredRecord,
  waitForPath,
} from './helpers';

afterEach(resetApp);

/** Checks that a group shows exactly these records, each as a full row. */
async function expectGroup(title: RegExp, others: StoredRecord[]): Promise<void> {
  const group = await findGroup(title);
  for (const other of others) expectRow(group, other);
  expect(numbersIn(group).sort()).toEqual(others.map((o) => o.number).sort());
}

describe('the related-records groups on each record page', () => {
  it('asks the API for the record’s links through GET /api/v1/<plural>/:id/links', async () => {
    const api = new LinksApi();
    await openRecord(R.ransomware, api);
    expect(api.linksCalls('risk', R.ransomware.id).length).toBeGreaterThan(0);
    for (const call of api.calls) expect(call.raw.startsWith('/api/v1/'), call.raw).toBe(true);
  });

  it('risk: assets exposed to it, controls that treat it, incidents that exposed it', async () => {
    await openRecord(R.ransomware, new LinksApi());
    await expectGroup(/^assets exposed to this risk$/i, [A.claims, A.portal]);
    await expectGroup(/^controls that treat this risk$/i, [C.mfa, C.review, C.vault]);
    await expectGroup(/^incidents that exposed this risk$/i, [I.phishing, I.fileShare]);
  });

  it('control: the risks it treats and the policies that govern it', async () => {
    await openRecord(C.mfa, new LinksApi());
    await expectGroup(/^risks it treats$/i, [R.ransomware]);
    await expectGroup(/^policies that govern it$/i, [P.infosec]);
  });

  it('policy: the controls it governs', async () => {
    await openRecord(P.infosec, new LinksApi());
    await expectGroup(/^controls it governs$/i, [C.mfa]);
  });

  it('incident: the assets it impacted and the risks it exposed', async () => {
    await openRecord(I.phishing, new LinksApi());
    await expectGroup(/^assets impacted$/i, [A.claims]);
    await expectGroup(/^risks exposed$/i, [R.ransomware]);
  });

  it('asset: risks it is exposed to and incidents that impacted it', async () => {
    await openRecord(A.claims, new LinksApi());
    await expectGroup(/^risks it is exposed to$/i, [R.ransomware]);
    await expectGroup(/^incidents that impacted it$/i, [I.phishing]);
  });

  it('asset: HOSTS both ways, telling "Hosts" from "Hosted by"', async () => {
    await openRecord(A.claims, new LinksApi());
    // A1 hosts A2; A4 hosts A1.
    await expectBothWays(
      { combined: /^hosts \/ hosted by$/i, out: /^hosts$/i, in: /^hosted by$/i },
      A.claimsApp,
      A.core,
      {
        outWord: /\bhosts\b/i,
        inWord: /\bhosted by\b/i,
      },
    );
  });

  it('asset: RUNS both ways, telling "Runs" from "Runs on"', async () => {
    await openRecord(A.claims, new LinksApi());
    // A1 runs A3; A6 runs A1.
    await expectBothWays({ combined: /^runs \/ runs on$/i, out: /^runs$/i, in: /^runs on$/i }, A.billing, A.cluster, {
      outWord: /\bruns\b(?! on)/i,
      inWord: /\bruns on\b/i,
    });
  });

  it('each number is a link that opens that record’s page', async () => {
    const { user } = await openRecord(R.ransomware, new LinksApi());
    const group = await findGroup(/^controls that treat this risk$/i);
    await user.click(within(rowFor(group, C.mfa.number)!).getByRole('link', { name: new RegExp(C.mfa.number) }));
    await waitForPath(`${PAGE_PATHS.control}/${C.mfa.id}`);
    await screen.findByRole('heading', { level: 1, name: new RegExp(C.mfa.number) });
  });

  it('shows a retired end’s status and each end’s own label', async () => {
    await openRecord(R.ransomware, new LinksApi());
    const group = await findGroup(/^controls that treat this risk$/i);
    expect((rowFor(group, C.review.number)!.textContent ?? '').toLowerCase()).toContain('retired');
    expect((rowFor(group, C.mfa.number)!.textContent ?? '').toLowerCase()).toContain('confidential');
    expect((rowFor(group, C.vault.number)!.textContent ?? '').toLowerCase()).toContain('restricted');
  });
});

/**
 * An asset-to-asset link type shows both directions: either as two groups, or as one combined group
 * where each row says which way the link goes.
 */
async function expectBothWays(
  titles: { combined: RegExp; out: RegExp; in: RegExp },
  outEnd: StoredRecord,
  inEnd: StoredRecord,
  words: { outWord: RegExp; inWord: RegExp },
): Promise<void> {
  await findGroup(new RegExp(`${titles.out.source}|${titles.combined.source}`, 'i'));
  const combined = queryGroup(titles.combined);
  if (combined) {
    const outRow = expectRow(combined, outEnd);
    const inRow = expectRow(combined, inEnd);
    const outText = (outRow.textContent ?? '').replace(outEnd.name, '');
    const inText = (inRow.textContent ?? '').replace(inEnd.name, '');
    expect(outText).toMatch(words.outWord);
    expect(outText).not.toMatch(words.inWord);
    expect(inText).toMatch(words.inWord);
    return;
  }
  const outGroup = await findGroup(titles.out);
  const inGroup = await findGroup(titles.in);
  expectRow(outGroup, outEnd);
  expectRow(inGroup, inEnd);
  expect(numbersIn(outGroup)).toEqual([outEnd.number]);
  expect(numbersIn(inGroup)).toEqual([inEnd.number]);
}
