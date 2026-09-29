// @vitest-environment jsdom
// S1-012 criterion 5: the API's refusals of POST /api/v1/links/remove show clear messages (D7: the
// web only hides buttons, the API decides; D47: one error format with a reference ID). The answers
// are S1-011's:
// - 404 `not_found` (an end or the link is gone or hidden): "This link no longer exists or you
//   can't see it", and the group is asked for again.
// - 403 `forbidden`: "You can't remove this link".
// - 409 `ai_link_review_only` (D207): "This link was found by the AI. It can only be removed through
//   the Analyst's review.", and the group is asked for again.
// - Anything else: the API's own message and its reference ID.
import { waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  AI_LINK_MESSAGE,
  C,
  confirmButton,
  findGroup,
  flush,
  LinksApi,
  openRecord,
  openRemove,
  pageText,
  R,
  resetApp,
  rowFor,
  type User,
} from './helpers';

afterEach(resetApp);

const RISK_CONTROLS = /^controls that treat this risk$/i;
const REMOVE = /^\/api\/v1\/links\/remove$/;

/** Opens R1, presses "Remove" on C1's row and confirms. Returns the links calls made before confirming. */
async function removeC1(api: LinksApi): Promise<{ before: number; user: User }> {
  const { user } = await openRecord(R.ransomware, api);
  const dialog = await openRemove(user, RISK_CONTROLS, C.mfa);
  const before = api.linksCalls('risk', R.ransomware.id).length;
  await user.click(confirmButton(dialog));
  await waitFor(() => expect(api.removeLinkCalls()).toHaveLength(1));
  await flush();
  return { before, user };
}

describe('404: the link is gone or hidden', () => {
  it('says "This link no longer exists or you can’t see it" and refreshes the group', async () => {
    const api = new LinksApi({ me: ADMIN });
    const { user } = await openRecord(R.ransomware, api);
    const dialog = await openRemove(user, RISK_CONTROLS, C.mfa);
    // Someone else removed it meanwhile: the fake now answers 404 and lists the group without it.
    api.links = api.links.filter((l) => !(l.fromId === R.ransomware.id && l.toId === C.mfa.id));
    const before = api.linksCalls('risk', R.ransomware.id).length;
    await user.click(confirmButton(dialog));
    await waitFor(() => expect(api.removeLinkCalls()).toHaveLength(1));
    await waitFor(() => expect(pageText()).toMatch(/this link no longer exists or you can.t see it/i));
    await waitFor(() => expect(api.linksCalls('risk', R.ransomware.id).length).toBeGreaterThan(before));
    const group = await findGroup(RISK_CONTROLS);
    await waitFor(() => expect(rowFor(group, C.mfa.number)).toBeNull());
  });

  it('a mocked 404 shows the same message', async () => {
    const api = new LinksApi({ me: ADMIN });
    api.fail('POST', REMOVE, {
      status: 404,
      code: 'not_found',
      message: 'The record was not found.',
      referenceId: 'ref-rm-404',
    });
    const { before } = await removeC1(api);
    await waitFor(() => expect(pageText()).toMatch(/this link no longer exists or you can.t see it/i));
    await waitFor(() => expect(api.linksCalls('risk', R.ransomware.id).length).toBeGreaterThan(before));
  });
});

describe('403: not allowed', () => {
  it('says "You can’t remove this link" and keeps the row', async () => {
    const api = new LinksApi({ me: ADMIN });
    api.fail('POST', REMOVE, {
      status: 403,
      code: 'forbidden',
      message: 'You may not do this.',
      referenceId: 'ref-rm-403',
    });
    await removeC1(api);
    await waitFor(() => expect(pageText()).toMatch(/you can.t remove this link/i));
    const group = await findGroup(RISK_CONTROLS);
    expect(rowFor(group, C.mfa.number)).toBeTruthy();
    expect(api.links.some((l) => l.fromId === R.ransomware.id && l.toId === C.mfa.id)).toBe(true);
  });
});

describe('409 ai_link_review_only (D207)', () => {
  it('shows the Analyst message and refreshes the group', async () => {
    const api = new LinksApi({ me: ADMIN });
    api.fail('POST', REMOVE, {
      status: 409,
      code: 'ai_link_review_only',
      message: AI_LINK_MESSAGE,
      referenceId: 'ref-rm-409',
    });
    const { before } = await removeC1(api);
    await waitFor(() =>
      expect(pageText()).toMatch(
        /this link was found by the ai\. it can only be removed through the analyst.s review\./i,
      ),
    );
    await waitFor(() => expect(api.linksCalls('risk', R.ransomware.id).length).toBeGreaterThan(before));
    const group = await findGroup(RISK_CONTROLS);
    expect(rowFor(group, C.mfa.number)).toBeTruthy();
  });

  it('the page’s own wording is used even when the API words it differently', async () => {
    const api = new LinksApi({ me: ADMIN });
    api.fail('POST', REMOVE, {
      status: 409,
      code: 'ai_link_review_only',
      message: 'Refused.',
      referenceId: 'ref-rm-409b',
    });
    await removeC1(api);
    await waitFor(() =>
      expect(pageText()).toMatch(
        /this link was found by the ai\. it can only be removed through the analyst.s review\./i,
      ),
    );
  });
});

describe('any other error', () => {
  it.each([
    { status: 500, code: 'internal_error', message: 'Something went wrong on our side.', referenceId: 'ref-rm-500' },
    { status: 400, code: 'validation_failed', message: 'The request body is not valid.', referenceId: 'ref-rm-400' },
    { status: 429, code: 'rate_limited', message: 'Too many requests. Wait a minute.', referenceId: 'ref-rm-429' },
  ])('$status $code shows the API’s message and reference ID', async (answer) => {
    const api = new LinksApi({ me: ADMIN });
    api.fail('POST', REMOVE, answer);
    await removeC1(api);
    await waitFor(() => expect(pageText()).toContain(answer.message));
    expect(pageText()).toContain(answer.referenceId);
    const group = await findGroup(RISK_CONTROLS);
    expect(rowFor(group, C.mfa.number)).toBeTruthy();
  });
});
