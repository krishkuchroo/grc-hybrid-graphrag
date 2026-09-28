// @vitest-environment jsdom
// S1-007 criterion 5: S1-006's stale-save, retire, 404 and label rules work on all four screens.
// - Stale save (D69): a 409 `stale_version` says "This record changed since you opened it", keeps
//   what was typed, says it needs re-applying, and Reload loads the latest version.
// - Retire (D69): asks for confirmation, sends `version`, and the record leaves the default list.
// - 404: "This record doesn't exist or you can't see it", the same for every cause.
// - Labels (D51, D198): the create form never offers a label above the clearance; the edit form
//   offers only the changes canChangeLabel allows, at or below the clearance.
// - Edit and Retire show only when the D50 table allows (the web hides; the API decides, D7).
// Each rule runs with one editor per kind (EDITORS), from the D50 table.
import { screen, waitFor, within } from '@testing-library/react';
import { can, canChangeLabel, isVisible, LABELS, ROLES, type Label } from '@grc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  API_PATHS,
  EDITORS,
  editControl,
  field,
  findDialog,
  findList,
  findTitle,
  mainText,
  NAV_NAMES,
  openEditForm,
  optionsOf,
  PATHS,
  recordId,
  recordNumber,
  renderApp,
  resetApp,
  rowNumbers,
  SCREEN_KINDS,
  ScreensApi,
  setField,
  submitButton,
  withRole,
  type Me,
  type ScreenKind,
  type User,
} from './helpers';

afterEach(resetApp);

const NOT_FOUND = /This record doesn.t exist or you can.t see it/;

/** The first record of each kind, an internal or confidential one every editor can see. */
const FIRST: Record<ScreenKind, { id: string; number: string; version: number }> = {
  control: { id: recordId('control', 1), number: recordNumber('control', 1), version: 2 },
  policy: { id: recordId('policy', 1), number: recordNumber('policy', 1), version: 2 },
  asset: { id: recordId('asset', 1), number: recordNumber('asset', 1), version: 2 },
  incident: { id: recordId('incident', 1), number: recordNumber('incident', 1), version: 2 },
};

function nameShown(): string {
  const input = screen.queryByLabelText(/^name/i) as HTMLInputElement | null;
  return input ? input.value : (screen.getByRole('main').textContent ?? '');
}

async function saveOverSomeoneElse(kind: ScreenKind): Promise<{ api: ScreensApi; user: User }> {
  const { id, number } = FIRST[kind];
  const { api, user } = renderApp(`${PATHS[kind]}/${id}`, new ScreensApi({ me: EDITORS[kind] }));
  await openEditForm(user, number);
  await setField(user, /^name/i, 'My typed name');
  api.changeBehindTheScenes(kind, id, 'Changed elsewhere');
  await user.click(submitButton());
  await waitFor(() => expect(api.callsTo(`${API_PATHS[kind]}/${id}`, 'PATCH')).toHaveLength(1));
  return { api, user };
}

describe('a stale save on every screen (criterion 5, D69)', () => {
  it.each(SCREEN_KINDS)('%s: says it changed, keeps the typed name and asks to re-apply', async (kind) => {
    await saveOverSomeoneElse(kind);
    expect(await screen.findByText(/This record changed since you opened it/)).toBeTruthy();
    expect(document.body.textContent).toMatch(/re-?apply|re-?enter|make your changes again/i);
    expect((field(/^name/i) as HTMLInputElement).value).toBe('My typed name');
  });

  it.each(SCREEN_KINDS)('%s: Reload loads the latest version', async (kind) => {
    const { api, user } = await saveOverSomeoneElse(kind);
    await screen.findByText(/This record changed since you opened it/);
    const path = `${API_PATHS[kind]}/${FIRST[kind].id}`;
    const reads = api.callsTo(path, 'GET').length;
    await user.click(screen.getByRole('button', { name: /reload/i }));
    await waitFor(() => expect(api.callsTo(path, 'GET').length).toBeGreaterThan(reads));
    await waitFor(() => expect(nameShown()).toContain('Changed elsewhere'));
  });
});

describe('retiring on every screen (criterion 5, D69)', () => {
  it.each(SCREEN_KINDS)('%s: Cancel sends nothing', async (kind) => {
    const { id, number } = FIRST[kind];
    const { api, user } = renderApp(`${PATHS[kind]}/${id}`, new ScreensApi({ me: EDITORS[kind] }));
    await findTitle(number);
    await user.click(screen.getByRole('button', { name: /^retire/i }));
    const dialog = await findDialog();
    await user.click(within(dialog).getByRole('button', { name: /cancel/i }));
    await waitFor(() => expect(screen.queryByRole('alertdialog') ?? screen.queryByRole('dialog')).toBeNull());
    expect(api.callsTo(`${API_PATHS[kind]}/${id}/retire`, 'POST')).toHaveLength(0);
  });

  it.each(SCREEN_KINDS)('%s: sends the version once confirmed, and the record leaves the list', async (kind) => {
    const { id, number, version } = FIRST[kind];
    const { api, user } = renderApp(PATHS[kind], new ScreensApi({ me: EDITORS[kind] }));
    const table = await findList();
    expect(rowNumbers(table)).toContain(number);
    await user.click(within(table).getByRole('link', { name: new RegExp(number) }));
    await findTitle(number);

    await user.click(screen.getByRole('button', { name: /^retire/i }));
    const dialog = await findDialog();
    await user.click(within(dialog).getByRole('button', { name: /retire/i }));
    const retire = `${API_PATHS[kind]}/${id}/retire`;
    await waitFor(() => expect(api.callsTo(retire, 'POST')).toHaveLength(1));
    expect(api.callsTo(retire, 'POST')[0]!.body).toEqual({ version });
    await waitFor(() => expect(api.record(kind, id)!.status).toBe('retired'));

    const nav = screen.getByRole('navigation', { name: /main/i });
    await user.click(within(nav).getByRole('link', { name: NAV_NAMES[kind] }));
    await waitFor(() => {
      const numbers = rowNumbers(screen.getByRole('table'));
      expect(numbers.length).toBeGreaterThan(0);
      expect(numbers).not.toContain(number);
    });
  });
});

describe('the one not-found page on every screen (criterion 5)', () => {
  it.each(SCREEN_KINDS)('%s: a record that does not exist', async (kind) => {
    renderApp(`${PATHS[kind]}/${recordId(kind, 999)}`, new ScreensApi({ me: EDITORS[kind] }));
    expect(await screen.findByText(NOT_FOUND)).toBeTruthy();
    expect(editControl()).toBeNull();
    expect(screen.queryByRole('button', { name: /^retire/i })).toBeNull();
  });

  it.each(SCREEN_KINDS)('%s: a record above the clearance reads the same as a missing one', async (kind) => {
    const me: Me = { ...EDITORS[kind], clearance: 'internal' };
    const plain = (t: string): string =>
      t.replace(/ref-[\w-]+/g, '').replace(/[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}/g, '');

    renderApp(`${PATHS[kind]}/${recordId(kind, 999)}`, new ScreensApi({ me }));
    await screen.findByText(NOT_FOUND);
    const missing = mainText();
    resetApp();

    const hidden = new ScreensApi({ me });
    const secret = hidden.records[kind][0]!;
    secret.label = 'restricted';
    secret.name = 'Board-only secret record';
    renderApp(`${PATHS[kind]}/${secret.id}`, hidden);
    await screen.findByText(NOT_FOUND);
    const above = mainText();
    expect(above).not.toContain('Board-only secret record');
    expect(plain(above)).toBe(plain(missing));
  });

  it.each(SCREEN_KINDS)("%s: does not pass on the 404's own message", async (kind) => {
    const api = new ScreensApi({ me: EDITORS[kind] });
    api.fail('GET', new RegExp(`^${API_PATHS[kind]}/[^/]+$`), {
      status: 404,
      code: 'not_found',
      message: 'Hidden by label policy',
      referenceId: 'ref-404-scr',
    });
    renderApp(`${PATHS[kind]}/${FIRST[kind].id}`, api);
    await screen.findByText(NOT_FOUND);
    expect(mainText()).not.toContain('Hidden by label policy');
  });
});

/** The label words a choice field offers, lowercased. */
async function labelOptions(user: User): Promise<string[]> {
  const shown = await optionsOf(user, field(/^label/i));
  return shown.map((t) => t.toLowerCase().split(/\s+/)[0]!).sort();
}

describe('the label rules on every screen (criterion 5, D51, D198)', () => {
  it.each(SCREEN_KINDS)('%s: the create form never offers a label above the clearance', async (kind) => {
    const me = EDITORS[kind];
    const { user } = renderApp(`${PATHS[kind]}/new`, new ScreensApi({ me }));
    await waitFor(() => field(/^name/i));
    const offered = await labelOptions(user);
    expect(offered).toEqual(LABELS.filter((l) => isVisible(me.clearance, l)).sort());
    expect(offered).not.toContain('restricted');
  });

  it.each(SCREEN_KINDS)('%s: the edit form offers only the changes canChangeLabel allows', async (kind) => {
    const me = EDITORS[kind];
    const { id, number } = FIRST[kind];
    const api = new ScreensApi({ me });
    const from = api.record(kind, id)!.label;
    const { user } = renderApp(`${PATHS[kind]}/${id}`, api);
    await openEditForm(user, number);
    const expected = LABELS.filter((to) => isVisible(me.clearance, to) && canChangeLabel(me.role, from, to)).sort();
    expect(await labelOptions(user)).toEqual(expected);
  });

  it.each(SCREEN_KINDS)('%s: a raised label is saved with the version', async (kind) => {
    const me: Me = { ...EDITORS[kind], clearance: 'restricted' };
    const { id, number, version } = FIRST[kind];
    const { api, user } = renderApp(`${PATHS[kind]}/${id}`, new ScreensApi({ me }));
    await openEditForm(user, number);
    await setField(user, /^label/i, 'Restricted');
    await user.click(submitButton());
    const path = `${API_PATHS[kind]}/${id}`;
    await waitFor(() => expect(api.callsTo(path, 'PATCH')).toHaveLength(1));
    expect(api.callsTo(path, 'PATCH')[0]!.body).toEqual({ label: 'restricted', version });
    await waitFor(() => expect(api.record(kind, id)!.label).toBe('restricted' as Label));
  });
});

describe('Edit and Retire follow the D50 table on every screen (criterion 5, D50)', () => {
  const cases = SCREEN_KINDS.flatMap((kind) =>
    ROLES.filter((role) => can(role, kind, 'view', { isOwner: true })).map((role) => [kind, role] as const),
  );

  it.each(cases)('%s, %s: shown only when the role may edit it', async (kind, role) => {
    const { id, number } = FIRST[kind];
    const api = new ScreensApi({ me: withRole(role, role === 'control_owner' ? 'user-priya' : undefined) });
    const owner = api.record(kind, id)!.owner;
    const allowed = can(role, kind, 'edit', { isOwner: owner === api.me.id });
    renderApp(`${PATHS[kind]}/${id}`, api);
    await findTitle(number);
    expect(editControl() !== null, 'Edit shown').toBe(allowed);
    expect(screen.queryByRole('button', { name: /^retire/i }) !== null, 'Retire shown').toBe(allowed);
  });

  it.each(
    SCREEN_KINDS.flatMap((kind) =>
      ROLES.filter((role) => can(role, kind, 'view', { isOwner: true })).map(
        (role) => [kind, role, can(role, kind, 'edit')] as const,
      ),
    ),
  )('%s, %s: "New" shown = %s', async (kind, role, allowed) => {
    renderApp(PATHS[kind], new ScreensApi({ me: withRole(role, role === 'control_owner' ? 'user-priya' : undefined) }));
    await findList();
    const name = new RegExp(`^new ${kind}`, 'i');
    const create = screen.queryByRole('link', { name }) ?? screen.queryByRole('button', { name });
    expect(create !== null).toBe(allowed);
  });

  it.each(SCREEN_KINDS)("%s: the API's 403 on a save still shows its message", async (kind) => {
    const { id, number } = FIRST[kind];
    const api = new ScreensApi({ me: EDITORS[kind] });
    api.fail('PATCH', new RegExp(`^${API_PATHS[kind]}/[^/]+$`), {
      status: 403,
      code: 'forbidden',
      message: 'You may not do this.',
      referenceId: `ref-save-403-${kind}`,
    });
    const { user } = renderApp(`${PATHS[kind]}/${id}`, api);
    await openEditForm(user, number);
    await setField(user, /^name/i, 'Renamed');
    await user.click(submitButton());
    await screen.findByText(/You may not do this\./);
    expect(document.body.textContent).toContain(`ref-save-403-${kind}`);
  });
});
