// @vitest-environment jsdom
// M0-015 criteria 1 and 3 (lock): the sign-in form, its field errors, the API's refusals and the
// lock message (D54: 12-character passwords, 5 failures lock the account for 15 min).
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FakeApi, findSignInForm, MFA_USER, renderApp, resetApp, submitSignIn, waitForPath } from './helpers';

afterEach(resetApp);

function describedBy(input: HTMLElement): string {
  const ids = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
}

describe('sign-in form (criterion 1)', () => {
  it('shows the sign-in form at /sign-in', async () => {
    renderApp('/sign-in');
    const form = await findSignInForm();
    expect(form.email).toBeTruthy();
    expect(form.password.getAttribute('type')).toBe('password');
  });

  it('sends a signed-out visitor from / to the sign-in page', async () => {
    renderApp('/');
    await findSignInForm();
    await waitForPath('/sign-in');
  });

  it('says a password needs at least 12 characters, on the field, without calling the API', async () => {
    const { api, user } = renderApp('/sign-in');
    await submitSignIn(user, MFA_USER.email, 'short-pass1');

    const message = await screen.findByText(/at least 12 characters/i);
    const { password } = await findSignInForm();
    expect(password.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(password)).toContain(message.textContent);
    expect(api.callsTo('/api/v1/auth/sign-in/email')).toHaveLength(0);
  });

  it('flags an email address that is not valid, on the field, without calling the API', async () => {
    const { api, user } = renderApp('/sign-in');
    await submitSignIn(user, 'not-an-email', MFA_USER.password);

    const message = await screen.findByText(/valid email/i);
    const { email } = await findSignInForm();
    expect(email.getAttribute('aria-invalid')).toBe('true');
    expect(describedBy(email)).toContain(message.textContent);
    expect(api.callsTo('/api/v1/auth/sign-in/email')).toHaveLength(0);
  });

  it('flags empty fields', async () => {
    const { api, user } = renderApp('/sign-in');
    const form = await findSignInForm();
    await user.click(form.submit);

    await waitFor(() => {
      expect(form.email.getAttribute('aria-invalid')).toBe('true');
      expect(form.password.getAttribute('aria-invalid')).toBe('true');
    });
    expect(describedBy(form.email)).not.toBe('');
    expect(describedBy(form.password)).not.toBe('');
    expect(api.callsTo('/api/v1/auth/sign-in/email')).toHaveLength(0);
  });

  it('sends the email and password to the API once the fields are valid', async () => {
    const { api, user } = renderApp('/sign-in');
    await submitSignIn(user, MFA_USER.email, MFA_USER.password);

    await screen.findByRole('textbox', { name: /code/i });
    const calls = api.callsTo('/api/v1/auth/sign-in/email');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toMatchObject({ email: MFA_USER.email, password: MFA_USER.password });
  });

  it("shows the API's refusal of a wrong password and stays on sign-in", async () => {
    const { user } = renderApp('/sign-in');
    await submitSignIn(user, MFA_USER.email, 'wrong-but-long-enough');

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/invalid email or password/i);
    expect(window.location.pathname).toBe('/sign-in');
    expect(screen.queryByText(new RegExp(MFA_USER.org.name))).toBeNull();
  });
});

describe('lock message (criterion 3)', () => {
  it('says when to try again after the account is locked', async () => {
    const api = new FakeApi();
    api.lockedSeconds = 14 * 60;
    const { user } = renderApp('/sign-in', api);
    await submitSignIn(user, MFA_USER.email, MFA_USER.password);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/try again in 14 min/i);
    expect(window.location.pathname).toBe('/sign-in');
  });

  it('does not show the lock message for an ordinary wrong password', async () => {
    const { user } = renderApp('/sign-in');
    await submitSignIn(user, MFA_USER.email, 'wrong-but-long-enough');

    await screen.findByRole('alert');
    expect(screen.queryByText(/try again in/i)).toBeNull();
  });
});
