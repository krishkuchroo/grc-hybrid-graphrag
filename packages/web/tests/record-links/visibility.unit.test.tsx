// @vitest-environment jsdom
// S1-008 criterion 2: only what GET …/:id/links returns is shown. There's no count or placeholder
// for hidden links (D51: a link is visible only if both ends are; S1-005 criterion 3: a link with a
// hidden end is never returned, not even as a count).
// Vic (Viewer, internal clearance) opens risk R1. Of its links, the API returns only A1 and C2:
// A5, C4 and I2 are restricted, C1 is confidential, and a Viewer can't view incidents at all (D50).
import { screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  A,
  C,
  cleanupPage,
  expectRow,
  findGroup,
  I,
  link,
  LinksApi,
  mainText,
  numbersIn,
  openRecord,
  R,
  resetApp,
  VIEWER,
} from './helpers';

afterEach(resetApp);

const HIDDEN = [A.portal, C.mfa, C.vault, I.phishing, I.fileShare];

/** Words a placeholder or count for hidden links would use. */
const PLACEHOLDER =
  /hidden|can.?t see|cannot see|not shown|restricted link|more link|other link|\+\s?\d+|\b\d+\s+(more|other|hidden)/i;

describe('only the links the API returns', () => {
  it('shows the visible ends and nothing of the hidden ones', async () => {
    await openRecord(R.ransomware, new LinksApi({ me: VIEWER }));
    const assets = await findGroup(/^assets exposed to this risk$/i);
    expectRow(assets, A.claims);
    expect(numbersIn(assets)).toEqual([A.claims.number]);
    const controls = await findGroup(/^controls that treat this risk$/i);
    expectRow(controls, C.review);
    expect(numbersIn(controls)).toEqual([C.review.number]);
    const text = mainText();
    for (const hidden of HIDDEN) {
      expect(text).not.toContain(hidden.number);
      expect(text).not.toContain(hidden.name);
    }
  });

  it('says nothing about how many links were left out', async () => {
    await openRecord(R.ransomware, new LinksApi({ me: VIEWER }));
    await findGroup(/^controls that treat this risk$/i);
    const text = mainText().replace(R.ransomware.name, '');
    expect(text).not.toMatch(PLACEHOLDER);
    // The API returned 2 of the 7 links: no "7", "5" or "2 of 7" appears as a count.
    expect(text).not.toMatch(/\b[57]\s*(links?|records?|related|controls?|assets?|incidents?)\b/i);
    expect(text).not.toMatch(/\b\d+\s+of\s+\d+\b/i);
  });

  it('a record whose links are all hidden looks the same as one with no links', async () => {
    // Every end of these links is hidden from Vic.
    const hiddenOnly = [
      link('EXPOSED_TO', A.portal, R.ransomware),
      link('MITIGATED_BY', R.ransomware, C.mfa),
      link('MITIGATED_BY', R.ransomware, C.vault),
      link('EXPOSES', I.phishing, R.ransomware),
    ];
    const api = new LinksApi({ me: VIEWER, links: hiddenOnly });
    await openRecord(R.ransomware, api);
    const withHidden = mainText();
    expect(api.linksCalls('risk', R.ransomware.id).length).toBeGreaterThan(0);

    cleanupPage();
    api.links = [];
    await openRecord(R.ransomware, api);
    const withNone = mainText();

    expect(withHidden).toBe(withNone);
    expect(screen.queryAllByRole('link', { name: /(AST|CTL|INC)\d{7}/ })).toHaveLength(0);
  });
});
