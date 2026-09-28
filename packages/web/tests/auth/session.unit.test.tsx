// @vitest-environment jsdom
// M0-015 criteria 3 (idle timeout) and 4 (the shell after sign-in, and sign-out).
// D54: sessions end after 30 min idle; the API then answers 401 on the next request.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FakeApi,
  findSignInForm,
  MFA_USER,
  OTHER_ORG_USER,
  renderApp,
  resetApp,
  signInFully,
  waitForPath,
  type User,
} from './helpers';

afterEach(resetApp);

const IDLE_MESSAGE = /inactiv|idle|expired|timed out/i;

/** Clicks a left-navigation link that leads away from the current page. */
async function moveToAnotherScreen(user: User): Promise<void> {
  const navs = await screen.findAllByRole('navigation');
  const links = navs.flatMap((nav) => within(nav).queryAllByRole('link')) as HTMLAnchorElement[];
  const other = links.find((a) => new URL(a.href, window.location.href).pathname !== window.location.pathname);
  expect(other, 'the left navigation has a link to another screen').toBeTruthy();
  await user.click(other!);
}

describe('the shell after sign-in (criterion 4)', () => {
  it("shows the org name, the user's name and role in the header", async () => {
    const { user } = renderApp('/sign-in');
    const banner = await signInFully(user, MFA_USER);

    expect(within(banner).getByText(new RegExp(MFA_USER.org.name))).toBeTruthy();
    expect(within(banner).getByText(new RegExp(MFA_USER.name))).toBeTruthy();
    expect(banner.textContent).toMatch(/risk manager/i);
  });

  it('has a left navigation with links to the screens', async () => {
    const { user } = renderApp('/sign-in');
    await signInFully(user, MFA_USER);

    const navs = await screen.findAllByRole('navigation');
    const links = navs.flatMap((nav) => within(nav).queryAllByRole('link'));
    expect(links.length).toBeGreaterThan(1);
  });

  it('opens the shell straight away for a signed-in user with MFA checked', async () => {
    const api = new FakeApi();
    api.startSession(MFA_USER.email, true);
    renderApp('/', api);

    const banner = await screen.findByRole('banner');
    await within(banner).findByText(new RegExp(MFA_USER.name));
    expect(banner.textContent).toContain(MFA_USER.org.name);
  });

  it('signs out: calls the API, returns to sign-in and drops the header', async () => {
    const { api, user } = renderApp('/sign-in');
    const banner = await signInFully(user, MFA_USER);
    await user.click(within(banner).getByRole('button', { name: /sign out/i }));

    await findSignInForm();
    await waitForPath('/sign-in');
    expect(api.callsTo('/api/v1/auth/sign-out')).toHaveLength(1);
    expect(screen.queryByText(new RegExp(MFA_USER.name))).toBeNull();
    expect(screen.queryByText(new RegExp(MFA_USER.org.name))).toBeNull();
    expect(screen.queryByText(IDLE_MESSAGE)).toBeNull();
  });

  it("shows only the next user's org after a sign-out and another sign-in", async () => {
    const { user } = renderApp('/sign-in');
    const first = await signInFully(user, MFA_USER);
    await user.click(within(first).getByRole('button', { name: /sign out/i }));
    await findSignInForm();

    const banner = await signInFully(user, OTHER_ORG_USER);
    await within(banner).findByText(new RegExp(OTHER_ORG_USER.name));
    expect(banner.textContent).toMatch(/compliance manager/i);
    expect(document.body.textContent).not.toContain(MFA_USER.org.name);
    expect(document.body.textContent).not.toContain(MFA_USER.name);
  });
});

describe('idle timeout (criterion 3)', () => {
  it('returns to sign-in with the idle message when a 401 arrives on an expired session', async () => {
    const { api, user } = renderApp('/sign-in');
    await signInFully(user, MFA_USER);
    api.expireSession();
    await moveToAnotherScreen(user);

    await findSignInForm();
    await waitForPath('/sign-in');
    expect(await screen.findByText(IDLE_MESSAGE)).toBeTruthy();
    expect(screen.queryByText(new RegExp(MFA_USER.org.name))).toBeNull();
  });

  it('lets the user sign in again from the idle message', async () => {
    const { api, user } = renderApp('/sign-in');
    await signInFully(user, MFA_USER);
    api.expireSession();
    await moveToAnotherScreen(user);
    await screen.findByText(IDLE_MESSAGE);

    const banner = await signInFully(user, MFA_USER);
    expect(within(banner).getByText(new RegExp(MFA_USER.name))).toBeTruthy();
  });

  it('shows no idle message to someone who was never signed in', async () => {
    const { api } = renderApp('/');
    await findSignInForm();
    await waitFor(() => expect(api.callsTo('/api/v1/me', 'GET').length).toBeGreaterThan(0));

    expect(screen.queryByText(IDLE_MESSAGE)).toBeNull();
  });
});
