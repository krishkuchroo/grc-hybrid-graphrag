// @vitest-environment jsdom
// S1-008 criterion 4: the API's `link_not_allowed`, `link_exists`, 403 and 404 answers show clear
// messages in the dialog, and nothing is added to the group. The web only hides what it knows the
// API would refuse; the API decides (D7). The answers are S1-005's (packages/api/src/records/
// links.service.ts), in the one D47 format with a reference ID; the not-found wording is the kit's
// one answer for a missing or hidden record (S1-006 criterion 7).
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addButton,
  ADMIN,
  C,
  flush,
  LinksApi,
  numbersIn,
  openAddLink,
  openRecord,
  pickLinkType,
  pickRecord,
  R,
  resetApp,
  search,
  type ErrorAnswer,
} from './helpers';

afterEach(resetApp);

/** Opens R1's dialog, picks control C3 (not yet linked), and presses add. */
async function tryToAdd(api: LinksApi): Promise<HTMLElement> {
  const { user } = await openRecord(R.ransomware, api);
  const dialog = await openAddLink(user);
  await pickLinkType(user, dialog, /^controls that treat this risk/i);
  await search(user, dialog, api, 'control', C.backups.number);
  await pickRecord(user, dialog, C.backups.number);
  await user.click(addButton(dialog));
  await waitFor(() => expect(api.postLinkCalls().length).toBe(1));
  await flush();
  return dialog;
}

/** The message shown for the refusal: an alert inside the dialog. */
async function refusal(): Promise<string> {
  const dialog = screen.getByRole('dialog');
  const alert = await within(dialog).findByRole('alert');
  return alert.textContent ?? '';
}

/**
 * The group behind the open dialog still lists only the three linked controls. "Add link" is a
 * modal dialog, so the page behind it is aria-hidden while it is open (correct behaviour: screen
 * readers reach only the dialog). The group is therefore looked up with `hidden: true`.
 */
async function expectGroupUnchanged(): Promise<void> {
  const group = await waitFor(() =>
    screen.getByRole('region', { name: /^controls that treat this risk$/i, hidden: true }),
  );
  expect(numbersIn(group).sort()).toEqual([C.mfa.number, C.review.number, C.vault.number].sort());
}

const CASES: Array<{ name: string; answer: ErrorAnswer; says: RegExp; showsReference: boolean }> = [
  {
    name: '400 link_not_allowed',
    answer: {
      status: 400,
      code: 'link_not_allowed',
      message: 'This link type is not allowed between these records.',
      referenceId: 'ref-not-allowed-1',
    },
    says: /not allowed/i,
    showsReference: true,
  },
  {
    name: '409 link_exists',
    answer: { status: 409, code: 'link_exists', message: 'This link already exists.', referenceId: 'ref-exists-1' },
    says: /already/i,
    showsReference: true,
  },
  {
    name: '403 forbidden',
    answer: { status: 403, code: 'forbidden', message: 'You may not do this.', referenceId: 'ref-forbidden-1' },
    says: /may not|permission|not allowed|can.?t/i,
    showsReference: true,
  },
  {
    name: '404 not_found',
    answer: { status: 404, code: 'not_found', message: 'The record was not found.', referenceId: 'ref-missing-1' },
    says: /doesn.?t exist|can.?t see|not found/i,
    showsReference: false,
  },
];

describe('the API’s refusals show clear messages', () => {
  for (const c of CASES) {
    it(`${c.name}: says so in the dialog and adds nothing`, async () => {
      const api = new LinksApi({ me: ADMIN });
      api.fail('POST', /^\/api\/v1\/links$/, c.answer);
      await tryToAdd(api);
      const text = await refusal();
      expect(text).toMatch(c.says);
      if (c.showsReference) expect(text).toContain(c.answer.referenceId);
      await expectGroupUnchanged();
    });
  }

  it('a refusal leaves the dialog open, so the person can pick another record', async () => {
    const api = new LinksApi({ me: ADMIN });
    api.fail('POST', /^\/api\/v1\/links$/, CASES[0]!.answer);
    await tryToAdd(api);
    await refusal();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });
});
