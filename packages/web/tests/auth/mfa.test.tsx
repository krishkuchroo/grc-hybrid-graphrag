// @vitest-environment jsdom
// M0-015 criterion 2: MFA for everyone (D54, TOTP plus backup codes).
// - A user without MFA is taken to set-up: confirm the password (Better Auth's enable call needs
//   it, and the app never keeps a password), then the QR code, then the backup codes shown once
//   with an "I have saved these" tick, then a confirm step with a code from the authenticator app.
// - A user with MFA gets the 6-digit check, with a "use a backup code" option.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BACKUP_CODES,
  FakeApi,
  findBanner,
  findCodeInput,
  MFA_USER,
  NEW_USER,
  passSecondFactor,
  renderApp,
  resetApp,
  submitSignIn,
  TOTP_CODE,
  type User,
} from './helpers';

afterEach(resetApp);

const SETUP_HEADING = /set up two-factor/i;

function isDisabled(el: HTMLElement): boolean {
  return el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
}

function storedText(): string {
  const all: string[] = [];
  for (const store of [window.localStorage, window.sessionStorage]) {
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)!;
      all.push(key, store.getItem(key) ?? '');
    }
  }
  return all.join('\n');
}

async function confirmPassword(user: User, password: string): Promise<void> {
  await screen.findByRole('heading', { name: SETUP_HEADING });
  await user.type(screen.getByLabelText(/password/i), password);
  await user.click(screen.getByRole('button', { name: /continue/i }));
}

async function goThroughQrAndCodes(user: User): Promise<void> {
  await screen.findByRole('img', { name: /qr code/i });
  await user.click(screen.getByRole('button', { name: /next|continue/i }));
  await screen.findByText(BACKUP_CODES[0]!);
  await user.click(screen.getByRole('checkbox', { name: /saved/i }));
  await user.click(screen.getByRole('button', { name: /next|continue/i }));
}

describe('MFA set-up for a user without MFA (criterion 2)', () => {
  it('takes the user to MFA set-up after a right password', async () => {
    const { user } = renderApp('/sign-in');
    await submitSignIn(user, NEW_USER.email, NEW_USER.password);

    await screen.findByRole('heading', { name: SETUP_HEADING });
    expect(screen.queryByRole('banner')?.textContent ?? '').not.toContain(NEW_USER.name);
  });

  it('takes a signed-in user without MFA to set-up when they open the app', async () => {
    const api = new FakeApi();
    api.startSession(NEW_USER.email, false);
    renderApp('/', api);

    await screen.findByRole('heading', { name: SETUP_HEADING });
  });

  it('starts set-up by confirming the password with the API', async () => {
    const { api, user } = renderApp('/sign-in');
    await submitSignIn(user, NEW_USER.email, NEW_USER.password);
    await confirmPassword(user, NEW_USER.password);

    await screen.findByRole('img', { name: /qr code/i });
    const calls = api.callsTo('/api/v1/auth/two-factor/enable');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ password: NEW_USER.password });
  });

  it('shows the QR code first, before any backup code', async () => {
    const { user } = renderApp('/sign-in');
    await submitSignIn(user, NEW_USER.email, NEW_USER.password);
    await confirmPassword(user, NEW_USER.password);

    await screen.findByRole('img', { name: /qr code/i });
    for (const code of BACKUP_CODES) expect(screen.queryByText(code)).toBeNull();
  });

  it('shows all backup codes after the QR code, and waits for the "saved them" tick', async () => {
    const { user } = renderApp('/sign-in');
    await submitSignIn(user, NEW_USER.email, NEW_USER.password);
    await confirmPassword(user, NEW_USER.password);
    await screen.findByRole('img', { name: /qr code/i });
    await user.click(screen.getByRole('button', { name: /next|continue/i }));

    for (const code of BACKUP_CODES) expect(await screen.findByText(code)).toBeTruthy();
    const next = screen.getByRole('button', { name: /next|continue/i });
    expect(isDisabled(next)).toBe(true);
    await user.click(screen.getByRole('checkbox', { name: /saved/i }));
    expect(isDisabled(next)).toBe(false);
  });

  it('confirms with a code from the authenticator app and lands in the shell', async () => {
    const { api, user } = renderApp('/sign-in');
    await submitSignIn(user, NEW_USER.email, NEW_USER.password);
    await confirmPassword(user, NEW_USER.password);
    await goThroughQrAndCodes(user);
    await passSecondFactor(user);

    const banner = await findBanner(NEW_USER);
    expect(within(banner).getByText(new RegExp(NEW_USER.name))).toBeTruthy();
    const verify = api.callsTo('/api/v1/auth/two-factor/verify-totp');
    expect(verify).toHaveLength(1);
    expect(verify[0]!.body).toMatchObject({ code: TOTP_CODE });
  });

  it('shows the backup codes only once: gone from the page and never stored', async () => {
    const { user } = renderApp('/sign-in');
    await submitSignIn(user, NEW_USER.email, NEW_USER.password);
    await confirmPassword(user, NEW_USER.password);
    await goThroughQrAndCodes(user);
    await passSecondFactor(user);
    await findBanner(NEW_USER);

    for (const code of BACKUP_CODES) expect(screen.queryByText(code)).toBeNull();
    const stored = storedText();
    for (const code of BACKUP_CODES) expect(stored).not.toContain(code);
    expect(stored).not.toContain('JBSWY3DPEHPK3PXP');
  });

  it('keeps the user on the confirm step when the code is wrong', async () => {
    const { user } = renderApp('/sign-in');
    await submitSignIn(user, NEW_USER.email, NEW_USER.password);
    await confirmPassword(user, NEW_USER.password);
    await goThroughQrAndCodes(user);
    await passSecondFactor(user, '000000');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/invalid code/i);
    expect(screen.queryByText(new RegExp(NEW_USER.org.name))).toBeNull();
  });
});

describe('MFA check for a user with MFA (criterion 2)', () => {
  it('asks for the 6-digit code after a right password, and never for set-up', async () => {
    const { user } = renderApp('/sign-in');
    await submitSignIn(user, MFA_USER.email, MFA_USER.password);

    await findCodeInput();
    expect(screen.queryByRole('heading', { name: SETUP_HEADING })).toBeNull();
    expect(screen.queryByRole('img', { name: /qr code/i })).toBeNull();
  });

  it('says the code has 6 digits, on the field, without calling the API', async () => {
    const { api, user } = renderApp('/sign-in');
    await submitSignIn(user, MFA_USER.email, MFA_USER.password);
    await passSecondFactor(user, '12345');

    await screen.findByText(/6 digits/i);
    const input = await findCodeInput();
    expect(input.getAttribute('aria-invalid')).toBe('true');
    expect(api.callsTo('/api/v1/auth/two-factor/verify-totp')).toHaveLength(0);
  });

  it('sends the code and opens the shell when it is right', async () => {
    const { api, user } = renderApp('/sign-in');
    await submitSignIn(user, MFA_USER.email, MFA_USER.password);
    await passSecondFactor(user);

    await findBanner(MFA_USER);
    const verify = api.callsTo('/api/v1/auth/two-factor/verify-totp');
    expect(verify).toHaveLength(1);
    expect(verify[0]!.body).toMatchObject({ code: TOTP_CODE });
  });

  it("shows the API's refusal of a wrong code and stays on the check", async () => {
    const { user } = renderApp('/sign-in');
    await submitSignIn(user, MFA_USER.email, MFA_USER.password);
    await passSecondFactor(user, '000000');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/invalid code/i);
    expect(await findCodeInput()).toBeTruthy();
    expect(screen.queryByText(new RegExp(MFA_USER.org.name))).toBeNull();
  });

  it('offers "use a backup code", which signs in with a backup code', async () => {
    const { api, user } = renderApp('/sign-in');
    await submitSignIn(user, MFA_USER.email, MFA_USER.password);
    await findCodeInput();
    await user.click(screen.getByRole('button', { name: /use a backup code/i }));

    const input = await screen.findByRole('textbox', { name: /backup code/i });
    await user.type(input, BACKUP_CODES[3]!);
    await user.click(screen.getByRole('button', { name: /verify|confirm|continue/i }));

    await findBanner(MFA_USER);
    const calls = api.callsTo('/api/v1/auth/two-factor/verify-backup-code');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ code: BACKUP_CODES[3] });
    expect(api.callsTo('/api/v1/auth/two-factor/verify-totp')).toHaveLength(0);
  });

  it('never asks the API to trust the device', async () => {
    const { api, user } = renderApp('/sign-in');
    await submitSignIn(user, MFA_USER.email, MFA_USER.password);
    await passSecondFactor(user);
    await findBanner(MFA_USER);

    await waitFor(() => expect(api.callsTo('/api/v1/auth/two-factor/verify-totp')).toHaveLength(1));
    const body = api.callsTo('/api/v1/auth/two-factor/verify-totp')[0]!.body as Record<string, unknown>;
    expect(body.trustDevice === undefined || body.trustDevice === false).toBe(true);
  });
});
