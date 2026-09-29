// @vitest-environment jsdom
// S1-012 criteria 2–4 (D201): "Remove" opens a confirmation naming the link in plain words and
// saying the removal is recorded in the audit trail; Cancel changes nothing; Confirm sends
// POST /api/v1/links/remove with the link's real direction (for an "in" row the other record is
// `fromId`); on success the row disappears, the group is asked for again, and a short message says so.
// Also criterion 6, the running side: every call is a relative /api/v1 address (the M0-015 rule).
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  A,
  ADMIN,
  cancelButton,
  confirmButton,
  C,
  findGroup,
  flush,
  LinksApi,
  numbersIn,
  openRecord,
  openRemove,
  pageText,
  queryConfirmation,
  R,
  resetApp,
  rowFor,
} from './helpers';

afterEach(resetApp);

const RISK_ASSETS = /^assets exposed to this risk$/i;
const RISK_CONTROLS = /^controls that treat this risk$/i;

describe('the confirmation (criterion 2)', () => {
  it('names the group, the other record’s number and name, and says it is recorded in the audit trail', async () => {
    const { user } = await openRecord(R.ransomware, new LinksApi({ me: ADMIN }));
    const dialog = await openRemove(user, RISK_CONTROLS, C.mfa);
    const text = dialog.textContent ?? '';
    expect(text.toLowerCase()).toContain('controls that treat this risk');
    expect(text).toContain(C.mfa.number);
    expect(text).toContain(C.mfa.name);
    expect(text).toMatch(/audit trail/i);
    expect(text).toMatch(/record/i);
  });

  it('Cancel closes it and changes nothing', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { user } = await openRecord(R.ransomware, api);
    const before = api.linksCalls('risk', R.ransomware.id).length;
    const dialog = await openRemove(user, RISK_CONTROLS, C.mfa);
    await user.click(cancelButton(dialog));
    await waitFor(() => expect(queryConfirmation()).toBeNull());
    await flush();
    expect(api.removeLinkCalls()).toHaveLength(0);
    expect(api.links).toHaveLength(13);
    const group = await findGroup(RISK_CONTROLS);
    expect(rowFor(group, C.mfa.number)).toBeTruthy();
    expect(api.linksCalls('risk', R.ransomware.id).length).toBe(before);
  });

  it('nothing is sent before Confirm', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { user } = await openRecord(R.ransomware, api);
    await openRemove(user, RISK_CONTROLS, C.mfa);
    await flush();
    expect(api.removeLinkCalls()).toHaveLength(0);
  });
});

describe('the request (criterion 3)', () => {
  it('an "out" row: this record is fromId', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { user } = await openRecord(R.ransomware, api);
    const dialog = await openRemove(user, RISK_CONTROLS, C.mfa);
    await user.click(confirmButton(dialog));
    await waitFor(() => expect(api.removeLinkCalls()).toHaveLength(1));
    expect(api.removeLinkCalls()[0]!.body).toEqual({
      type: 'MITIGATED_BY',
      fromId: R.ransomware.id,
      toId: C.mfa.id,
    });
  });

  it('an "in" row: the other record is fromId', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { user } = await openRecord(R.ransomware, api);
    const dialog = await openRemove(user, RISK_ASSETS, A.claims);
    await user.click(confirmButton(dialog));
    await waitFor(() => expect(api.removeLinkCalls()).toHaveLength(1));
    expect(api.removeLinkCalls()[0]!.body).toEqual({
      type: 'EXPOSED_TO',
      fromId: A.claims.id,
      toId: R.ransomware.id,
    });
  });

  it('an asset’s "Hosted by" row: the host is fromId', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { user } = await openRecord(A.claims, api);
    const dialog = await openRemove(user, /^(hosted by|hosts \/ hosted by)$/i, A.core);
    await user.click(confirmButton(dialog));
    await waitFor(() => expect(api.removeLinkCalls()).toHaveLength(1));
    expect(api.removeLinkCalls()[0]!.body).toEqual({ type: 'HOSTS', fromId: A.core.id, toId: A.claims.id });
  });

  it('an asset’s "Runs" row (an import link): the asset is fromId', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { user } = await openRecord(A.claims, api);
    const dialog = await openRemove(user, /^(runs|runs \/ runs on)$/i, A.billing);
    await user.click(confirmButton(dialog));
    await waitFor(() => expect(api.removeLinkCalls()).toHaveLength(1));
    expect(api.removeLinkCalls()[0]!.body).toEqual({ type: 'RUNS', fromId: A.claims.id, toId: A.billing.id });
  });
});

describe('after a removal (criterion 4)', () => {
  it('the row disappears, the group is asked for again, and a short message confirms it', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { user } = await openRecord(R.ransomware, api);
    const before = api.linksCalls('risk', R.ransomware.id).length;
    const dialog = await openRemove(user, RISK_CONTROLS, C.mfa);
    await user.click(confirmButton(dialog));
    await waitFor(() => expect(api.removeLinkCalls()).toHaveLength(1));
    await waitFor(() => expect(api.linksCalls('risk', R.ransomware.id).length).toBeGreaterThan(before));
    await waitFor(() => expect(queryConfirmation()).toBeNull());
    const group = await findGroup(RISK_CONTROLS);
    await waitFor(() => expect(rowFor(group, C.mfa.number)).toBeNull());
    expect(numbersIn(group).sort()).toEqual([C.review.number, C.vault.number].sort());
    expect(api.links.some((l) => l.fromId === R.ransomware.id && l.toId === C.mfa.id)).toBe(false);
    await waitFor(() => expect(pageText()).toMatch(/removed/i));
    expect(screen.getByRole('heading', { level: 1, name: new RegExp(R.ransomware.number) })).toBeTruthy();
  });

  it('other rows keep their "Remove"', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { user } = await openRecord(R.ransomware, api);
    const dialog = await openRemove(user, RISK_CONTROLS, C.mfa);
    await user.click(confirmButton(dialog));
    const group = await findGroup(RISK_CONTROLS);
    await waitFor(() => expect(rowFor(group, C.mfa.number)).toBeNull());
    await openRemove(user, RISK_CONTROLS, C.review);
  });
});

describe('the running side (criterion 6)', () => {
  it('a removal only ever calls /api/v1 on the page origin', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { user } = await openRecord(R.ransomware, api);
    const dialog = await openRemove(user, /^controls that treat this risk$/i, C.mfa);
    await user.click(confirmButton(dialog));
    await waitFor(() => expect(api.removeLinkCalls()).toHaveLength(1));
    const call = api.removeLinkCalls()[0]!;
    expect(call.raw).toBe('/api/v1/links/remove');
    for (const c of api.calls) {
      expect(c.url.origin, c.raw).toBe(window.location.origin);
      expect(c.url.pathname.startsWith('/api/v1/'), c.raw).toBe(true);
      expect(c.raw, 'no host in the address').not.toMatch(/^https?:|grc\.localhost|127\.0\.0\.1/);
    }
  });
});
