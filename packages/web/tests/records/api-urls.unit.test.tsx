// @vitest-environment jsdom
// S1-006 criterion 8, the running side (the M0-015 rule): a walk through the register, a record, an
// edit and a retire only ever calls /api/v1 on the page's own origin. The code side is in
// records-client.unit.test.ts.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { field, findDialog, findRegister, renderApp, resetApp, setField } from './helpers';

afterEach(resetApp);

describe('API addresses at run time (criterion 8, running side)', () => {
  it('sends every request to /api/v1 on the page origin', async () => {
    const { api, user } = renderApp('/risks?q=ransom');
    const table = await findRegister();
    await user.click(within(table).getByRole('link', { name: /RSK0001001/ }));
    await screen.findByRole('heading', { level: 1, name: /RSK0001001/ });

    const edit = screen.queryByRole('button', { name: /^edit/i }) ?? screen.queryByRole('link', { name: /^edit/i });
    await user.click(edit!);
    await waitFor(() => field(/^name/i));
    await setField(user, /^name/i, 'Ransomware on all servers');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(api.callsTo(/^\/api\/v1\/risks\/[^/]+$/, 'PATCH')).toHaveLength(1));

    await waitFor(() => screen.getByRole('button', { name: /^retire/i }));
    await user.click(screen.getByRole('button', { name: /^retire/i }));
    const dialog = await findDialog();
    await user.click(within(dialog).getByRole('button', { name: /retire/i }));
    await waitFor(() => expect(api.callsTo(/\/retire$/, 'POST')).toHaveLength(1));

    const paths = new Set(api.calls.map((c) => c.url.pathname));
    expect(paths.has('/api/v1/risks')).toBe(true);
    for (const call of api.calls) {
      expect(call.url.origin, call.raw).toBe(window.location.origin);
      expect(call.url.pathname.startsWith('/api/v1/'), call.raw).toBe(true);
      expect(call.raw, 'no host in the address').not.toMatch(/^https?:|grc\.localhost|127\.0\.0\.1/);
    }
  });
});
