// @vitest-environment jsdom
// S1-007 criterion 3 (D50, D199, D206): a Control Owner's Controls list shows only their controls,
// with a note saying so, and they can edit those. They see no "New control" button (creating a
// control needs full edit: Admin or Compliance Manager). Their edit form has the owner picker like
// everyone else's; when a save hands the control to someone else and the API answers 200, the
// screen says the control is now owned by the new owner, returns to the Controls list, and the
// control is no longer in it. It never shows the "doesn't exist or you can't see it" page for it.
// The API decides who sees what (D7): the fake answers only the owner's controls, and 404 for
// the rest, as S1-003 does.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  API_PATHS,
  COMPLIANCE_MANAGER,
  CONTROL_OWNER,
  editControl,
  field,
  findList,
  findTitle,
  MEMBERS,
  newButton,
  openEditForm,
  optionsOf,
  recordId,
  renderApp,
  resetApp,
  RISK_MANAGER,
  rowNumbers,
  ScreensApi,
  setField,
  submitButton,
  textOutsideChoices,
  waitForPath,
} from './helpers';

afterEach(resetApp);

const NOT_FOUND = /This record doesn.t exist or you can.t see it/;
/** The note on a Control Owner's list: only the controls they own. */
const OWN_NOTE = /only\b.{0,40}\b(you own|assigned to you|owned by you|your (own )?controls)/i;

/** Watches the page from now on: `stop()` says whether text matching `re` was ever added. */
function watchFor(re: RegExp): { stop: () => boolean } {
  let seen = re.test(document.body.textContent ?? '');
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'characterData' && re.test(record.target.textContent ?? '')) seen = true;
      record.addedNodes.forEach((node) => {
        if (re.test(node.textContent ?? '')) seen = true;
      });
    }
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  return {
    stop: () => {
      for (const record of observer.takeRecords()) {
        record.addedNodes.forEach((node) => {
          if (re.test(node.textContent ?? '')) seen = true;
        });
      }
      observer.disconnect();
      return seen;
    },
  };
}

const OWNED = recordId('control', 1);
const OWNED_PATH = `${API_PATHS.control}/${OWNED}`;

describe("a Control Owner's Controls list (criterion 3)", () => {
  it('shows only their own controls, as the API answers them', async () => {
    renderApp('/controls', new ScreensApi({ me: CONTROL_OWNER }));
    const table = await findList();
    expect(rowNumbers(table)).toEqual(['CTL0001001', 'CTL0001003']);
  });

  it('says the list holds only their controls', async () => {
    renderApp('/controls', new ScreensApi({ me: CONTROL_OWNER }));
    await findList();
    expect(screen.getByRole('main').textContent).toMatch(OWN_NOTE);
  });

  it.each([
    ['an Admin', ADMIN],
    ['a Compliance Manager', COMPLIANCE_MANAGER],
    ['a Risk Manager', RISK_MANAGER],
  ] as const)('shows no such note to %s, who sees every control', async (_who, me) => {
    renderApp('/controls', new ScreensApi({ me }));
    const table = await findList();
    expect(rowNumbers(table)).toEqual(expect.arrayContaining(['CTL0001001', 'CTL0001002', 'CTL0001004']));
    expect(screen.getByRole('main').textContent).not.toMatch(OWN_NOTE);
  });

  it('offers them no "New control" button (D199)', async () => {
    renderApp('/controls', new ScreensApi({ me: CONTROL_OWNER }));
    await findList();
    expect(newButton('control')).toBeNull();
  });
});

describe('a Control Owner edits their own control (criterion 3)', () => {
  it('shows Edit on a control they own', async () => {
    renderApp(`/controls/${OWNED}`, new ScreensApi({ me: CONTROL_OWNER }));
    await findTitle('CTL0001001');
    expect(editControl()).not.toBeNull();
  });

  it("gets the one not-found page for a control they don't own", async () => {
    renderApp(`/controls/${recordId('control', 2)}`, new ScreensApi({ me: CONTROL_OWNER }));
    expect(await screen.findByText(NOT_FOUND)).toBeTruthy();
    expect(screen.getByRole('main').textContent).not.toContain('Quarterly access review');
    expect(editControl()).toBeNull();
  });

  it('saves a change to their control with its version', async () => {
    const { api, user } = renderApp(`/controls/${OWNED}`, new ScreensApi({ me: CONTROL_OWNER }));
    await openEditForm(user, 'CTL0001001');
    await setField(user, /^control status/i, 'Planned');
    await user.click(submitButton());
    await waitFor(() => expect(api.callsTo(OWNED_PATH, 'PATCH')).toHaveLength(1));
    expect(api.callsTo(OWNED_PATH, 'PATCH')[0]!.body).toEqual({ controlStatus: 'planned', version: 2 });
    await waitFor(() => expect(api.record('control', OWNED)!.controlStatus).toBe('planned'));
    expect(screen.queryByText(NOT_FOUND)).toBeNull();
  });

  it('has the owner picker on their edit form, open, listing the org members (D206)', async () => {
    const { user } = renderApp(`/controls/${OWNED}`, new ScreensApi({ me: CONTROL_OWNER }));
    await openEditForm(user, 'CTL0001001');
    const owner = field(/^owner/i);
    expect(owner.hasAttribute('disabled')).toBe(false);
    expect(owner.getAttribute('aria-disabled')).not.toBe('true');
    expect(owner.getAttribute('aria-readonly')).not.toBe('true');
    const shown = await optionsOf(user, owner);
    for (const person of MEMBERS)
      expect(
        shown.some((t) => t.includes(person.name)),
        person.name,
      ).toBe(true);
  });
});

describe('a Control Owner hands their control to someone else (criterion 3, D206)', () => {
  async function handOver() {
    const api = new ScreensApi({ me: CONTROL_OWNER });
    const { user } = renderApp('/controls', api);
    const table = await findList();
    expect(rowNumbers(table)).toContain('CTL0001001');
    await user.click(within(table).getByRole('link', { name: /CTL0001001/ }));
    await openEditForm(user, 'CTL0001001');
    await setField(user, /^owner/i, 'Marcus Bell');
    const listCallsBefore = api.listCalls('control').length;
    const watcher = watchFor(NOT_FOUND);
    await user.click(submitButton());
    await waitFor(() => expect(api.callsTo(OWNED_PATH, 'PATCH')).toHaveLength(1));
    return { api, user, listCallsBefore, watcher };
  }

  it('sends the new owner and the version', async () => {
    const { api } = await handOver();
    expect(api.callsTo(OWNED_PATH, 'PATCH')[0]!.body).toEqual({ owner: 'user-marcus', version: 2 });
    await waitFor(() => expect(api.record('control', OWNED)!.owner).toBe('user-marcus'));
  });

  it('says the control is now owned by the new owner', async () => {
    await handOver();
    await waitFor(() =>
      expect(textOutsideChoices()).toMatch(/(owned by|handed (it )?(over )?to|now belongs to) Marcus Bell/i),
    );
  });

  it('returns to the Controls list, reloaded, without that control', async () => {
    const { api, listCallsBefore } = await handOver();
    await waitForPath('/controls');
    await waitFor(() => expect(api.listCalls('control').length).toBeGreaterThan(listCallsBefore));
    await waitFor(() => expect(rowNumbers(screen.getByRole('table'))).toEqual(['CTL0001003']));
    expect(textOutsideChoices()).toMatch(/(owned by|handed (it )?(over )?to|now belongs to) Marcus Bell/i);
  });

  it('never shows the not-found page for the control it handed over, not even for a moment', async () => {
    const { api, watcher } = await handOver();
    await waitForPath('/controls');
    await waitFor(() => expect(rowNumbers(screen.getByRole('table'))).toEqual(['CTL0001003']));
    expect(watcher.stop(), 'the not-found message appeared after the save').toBe(false);
    expect(screen.queryByText(NOT_FOUND)).toBeNull();
    expect(document.body.textContent).not.toMatch(NOT_FOUND);
    expect(api.record('control', OWNED)!.owner).toBe('user-marcus');
  });

  it("an Admin changing a control's owner stays on its page, which still shows it", async () => {
    const { api, user } = renderApp(`/controls/${OWNED}`, new ScreensApi({ me: ADMIN }));
    await openEditForm(user, 'CTL0001001');
    await setField(user, /^owner/i, 'Dana Whitfield');
    await user.click(submitButton());
    await waitFor(() => expect(api.callsTo(OWNED_PATH, 'PATCH')).toHaveLength(1));
    await waitFor(() => expect(api.record('control', OWNED)!.owner).toBe('user-dana'));
    await findTitle('CTL0001001');
    expect(window.location.pathname).toBe(`/controls/${OWNED}`);
    expect(screen.queryByText(NOT_FOUND)).toBeNull();
  });
});
