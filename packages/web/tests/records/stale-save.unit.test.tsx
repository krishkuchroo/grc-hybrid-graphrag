// @vitest-environment jsdom
// S1-006 criterion 5 (D69): a 409 `stale_version` shows "This record changed since you opened it",
// with a Reload button that loads the latest version. The typed changes are not silently thrown
// away: the message says they need to be re-applied.
import { screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { field, renderApp, resetApp, riskId, setField, type RecordsApi, type User } from './helpers';

afterEach(resetApp);

const ID = riskId(1);
const RECORD = `/api/v1/risks/${ID}`;

async function openEditForm(user: User): Promise<void> {
  const edit = screen.queryByRole('button', { name: /^edit/i }) ?? screen.queryByRole('link', { name: /^edit/i });
  expect(edit, 'an Edit button or link').toBeTruthy();
  await user.click(edit!);
  await waitFor(() => field(/^name/i));
}

/** The name as shown: the edit form's value if it is open, else the page's text. */
function shownName(): string {
  const nameInput = screen.queryByLabelText(/^name/i) as HTMLInputElement | null;
  return nameInput ? nameInput.value : (screen.getByRole('main').textContent ?? '');
}

/** Opens the edit form, lets someone else save first, then saves a new name. */
async function saveOverSomeoneElse(): Promise<{ api: RecordsApi; user: User }> {
  const { api, user } = renderApp(`/risks/${ID}`);
  await screen.findByRole('heading', { level: 1, name: /RSK0001001/ });
  await openEditForm(user);
  await setField(user, /^name/i, 'My typed name');
  api.changeBehindTheScenes(ID, 'Changed elsewhere');
  await user.click(screen.getByRole('button', { name: /^save/i }));
  await waitFor(() => expect(api.callsTo(RECORD, 'PATCH')).toHaveLength(1));
  return { api, user };
}

describe('a stale save (criterion 5)', () => {
  it('says the record changed since it was opened', async () => {
    await saveOverSomeoneElse();
    expect(await screen.findByText(/This record changed since you opened it/)).toBeTruthy();
  });

  it('keeps what was typed and says the changes need re-applying', async () => {
    await saveOverSomeoneElse();
    await screen.findByText(/This record changed since you opened it/);
    expect(document.body.textContent).toMatch(/re-?apply|re-?enter|make your changes again/i);
    expect((field(/^name/i) as HTMLInputElement).value).toBe('My typed name');
  });

  it('offers a Reload button that loads the latest version', async () => {
    const { api, user } = await saveOverSomeoneElse();
    await screen.findByText(/This record changed since you opened it/);
    const readsBefore = api.callsTo(RECORD, 'GET').length;
    await user.click(screen.getByRole('button', { name: /reload/i }));

    await waitFor(() => expect(api.callsTo(RECORD, 'GET').length).toBeGreaterThan(readsBefore));
    await waitFor(() => expect(shownName()).toContain('Changed elsewhere'));
  });

  it('saves with the new version after a reload', async () => {
    const { api, user } = await saveOverSomeoneElse();
    await screen.findByText(/This record changed since you opened it/);
    await user.click(screen.getByRole('button', { name: /reload/i }));
    await waitFor(() => expect(shownName()).toContain('Changed elsewhere'));
    if (!screen.queryByLabelText(/^name/i)) await openEditForm(user);
    await waitFor(() => expect((field(/^name/i) as HTMLInputElement).value).toBe('Changed elsewhere'));

    await setField(user, /^name/i, 'My typed name');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(api.callsTo(RECORD, 'PATCH')).toHaveLength(2));
    const body = api.callsTo(RECORD, 'PATCH')[1]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ name: 'My typed name', version: 4 });
    await waitFor(() => expect(api.risk(ID)!.name).toBe('My typed name'));
  });
});
