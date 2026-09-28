// @vitest-environment jsdom
// M0-015 criterion 5 (the running side): every request the app makes on the way through sign-in,
// the MFA check, the shell and sign-out goes to a relative /api/v1 address on the page's own
// origin, never to a host written into the app.
import { within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { findSignInForm, MFA_USER, renderApp, resetApp, signInFully } from './helpers';

afterEach(resetApp);

describe('API addresses at run time (criterion 5)', () => {
  it('sends every request to /api/v1 on the page origin', async () => {
    const { api, user } = renderApp('/');
    await findSignInForm();
    const banner = await signInFully(user, MFA_USER);
    await user.click(within(banner).getByRole('button', { name: /sign out/i }));
    await findSignInForm();

    expect(api.calls.length).toBeGreaterThanOrEqual(4);
    for (const call of api.calls) {
      expect(call.url.origin, call.raw).toBe(window.location.origin);
      expect(call.url.pathname.startsWith('/api/v1/'), call.raw).toBe(true);
      expect(call.raw, 'no host in the address').not.toMatch(/grc\.localhost|127\.0\.0\.1/);
    }
  });
});
