// @vitest-environment jsdom
// S1-007 criterion 4 (D50): Incidents is "no access" for a Control Owner and a Viewer. When they
// open it, the API answers 403 on the list route (S1 shared notes) and the screen says they don't
// have access, with the API's message and reference ID (D47, as S1-006's 403 state). The nav item
// stays visible and leads to that message. Every other role sees the list.
// The roles come from ROLE_TABLE, so the tests follow the D50 table rather than a copy of it.
import { screen, waitFor, within } from '@testing-library/react';
import { can, ROLES } from '@grc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CONTROL_OWNER,
  findList,
  mainText,
  newButton,
  recordId,
  renderApp,
  resetApp,
  rowNumbers,
  ScreensApi,
  VIEWER,
  waitForPath,
  withRole,
} from './helpers';

afterEach(resetApp);

const NO_ACCESS = /you don.t have access/i;
const NOT_FOUND = /This record doesn.t exist or you can.t see it/;

const BARRED = ROLES.filter((role) => !can(role, 'incident', 'view'));
const ALLOWED = ROLES.filter((role) => can(role, 'incident', 'view'));

describe('Incidents for a role with no access (criterion 4)', () => {
  it.each([
    ['a Control Owner', CONTROL_OWNER],
    ['a Viewer', VIEWER],
  ] as const)('%s sees the nav item, and it leads to the no-access screen', async (_who, me) => {
    const { api, user } = renderApp('/', new ScreensApi({ me }));
    const nav = await screen.findByRole('navigation', { name: /main/i });
    const item = within(nav).getByRole('link', { name: /^incidents$/i });
    await user.click(item);
    await waitForPath('/incidents');
    await waitFor(() => expect(api.listCalls('incident').length).toBeGreaterThan(0));
    expect(await screen.findByText(NO_ACCESS)).toBeTruthy();
  });

  it.each(BARRED.map((role) => [role] as const))(
    "%s: the screen shows the API's 403 message and reference ID, and no list",
    async (role) => {
      const api = new ScreensApi({ me: withRole(role) });
      api.fail('GET', /^\/api\/v1\/incidents$/, {
        status: 403,
        code: 'forbidden',
        message: 'You do not have permission to do this.',
        referenceId: `ref-inc-403-${role}`,
      });
      renderApp('/incidents', api);
      await screen.findByText(NO_ACCESS);
      await screen.findByText(/You do not have permission to do this\./);
      expect(mainText()).toContain(`ref-inc-403-${role}`);
      expect(screen.queryByRole('table')).toBeNull();
      expect(newButton('incident')).toBeNull();
      expect(mainText()).not.toMatch(/Phishing email led to credential theft/);
    },
  );

  it.each(BARRED.map((role) => [role] as const))(
    '%s: an incident page is the one not-found page, as the API answers 404',
    async (role) => {
      renderApp(`/incidents/${recordId('incident', 2)}`, new ScreensApi({ me: withRole(role) }));
      expect(await screen.findByText(NOT_FOUND)).toBeTruthy();
      expect(mainText()).not.toContain('Lost laptop');
    },
  );
});

describe('Incidents for every role with access (criterion 4)', () => {
  it.each(ALLOWED.map((role) => [role] as const))('%s sees the list', async (role) => {
    renderApp('/incidents', new ScreensApi({ me: withRole(role) }));
    const table = await findList();
    expect(rowNumbers(table)).toEqual(['INC0001001', 'INC0001002', 'INC0001003', 'INC0001004']);
    expect(screen.queryByText(NO_ACCESS)).toBeNull();
  });
});
