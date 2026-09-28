// @vitest-environment jsdom
// S1-006 criterion 6 (D69: retire, never delete): Retire asks for confirmation, sends `version`,
// and the record drops out of the default (active) list.
import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { findDialog, findRegister, renderApp, resetApp, riskId, rowNumbers } from './helpers';

afterEach(resetApp);

const ID = riskId(1);
const RETIRE = `/api/v1/risks/${ID}/retire`;

describe('retiring a risk (criterion 6)', () => {
  it('asks for confirmation, and Cancel sends nothing', async () => {
    const { api, user } = renderApp(`/risks/${ID}`);
    await screen.findByRole('heading', { level: 1, name: /RSK0001001/ });
    await user.click(screen.getByRole('button', { name: /^retire/i }));
    const dialog = await findDialog();
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog') ?? screen.queryByRole('dialog')).toBeNull());
    expect(api.callsTo(RETIRE, 'POST')).toHaveLength(0);
    expect(api.risk(ID)!.status).toBe('active');
  });

  it('sends the version once confirmed', async () => {
    const { api, user } = renderApp(`/risks/${ID}`);
    await screen.findByRole('heading', { level: 1, name: /RSK0001001/ });
    await user.click(screen.getByRole('button', { name: /^retire/i }));
    const dialog = await findDialog();
    await user.click(within(dialog).getByRole('button', { name: /retire/i }));
    await waitFor(() => expect(api.callsTo(RETIRE, 'POST')).toHaveLength(1));
    expect(api.callsTo(RETIRE, 'POST')[0]!.body).toEqual({ version: 3 });
    await waitFor(() => expect(api.risk(ID)!.status).toBe('retired'));
  });

  it('drops the record out of the default list, even when the list was open before', async () => {
    const { api, user } = renderApp('/risks');
    const table = await findRegister();
    expect(rowNumbers(table)).toContain('RSK0001001');
    await user.click(within(table).getByRole('link', { name: /RSK0001001/ }));
    await screen.findByRole('heading', { level: 1, name: /RSK0001001/ });

    await user.click(screen.getByRole('button', { name: /^retire/i }));
    const dialog = await findDialog();
    await user.click(within(dialog).getByRole('button', { name: /retire/i }));
    await waitFor(() => expect(api.risk(ID)!.status).toBe('retired'));

    const nav = screen.getByRole('navigation', { name: /main/i });
    await user.click(within(nav).getByRole('link', { name: /risk register/i }));
    await waitFor(() => {
      const numbers = rowNumbers(screen.getByRole('table'));
      expect(numbers).toContain('RSK0001002');
      expect(numbers).not.toContain('RSK0001001');
    });
  });
});
