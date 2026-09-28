// @vitest-environment jsdom
// S1-006 criterion 4: the create and edit forms. They validate with the shared S1-001 schemas
// before sending; the label chooser offers only what canChangeLabel allows and never a label above
// the person's clearance (D51, D198); the owner picker lists the org's members from
// GET /api/v1/people on both forms, never hidden or locked by role (D206); save sends `version`
// (D69).
import { screen, waitFor } from '@testing-library/react';
import { canChangeLabel, isVisible, LABELS, type Label } from '@grc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  field,
  optionsOf,
  PEOPLE,
  RecordsApi,
  renderApp,
  resetApp,
  RISK_MANAGER,
  riskId,
  setField,
  type Me,
  type User,
} from './helpers';

afterEach(resetApp);

async function findCreateForm(): Promise<void> {
  await waitFor(() => field(/^name/i));
}

function submitButton(): HTMLElement {
  return screen.getByRole('button', { name: /^(save|create)/i });
}

/** Opens the record page and its edit form. */
async function openEditForm(user: User, id: string): Promise<void> {
  await screen.findByRole('heading', { level: 1, name: /RSK\d{7}/ });
  const edit = screen.queryByRole('button', { name: /^edit/i }) ?? screen.queryByRole('link', { name: /^edit/i });
  expect(edit, 'an Edit button or link').toBeTruthy();
  await user.click(edit!);
  await waitFor(() => field(/^name/i));
  expect(window.location.pathname.startsWith(`/risks/${id}`)).toBe(true);
}

/** The label words a choice field offers, lowercased (`Confidential` → `confidential`). */
async function labelOptions(user: User): Promise<string[]> {
  const shown = await optionsOf(user, field(/^label/i));
  return shown.map((t) => t.toLowerCase().split(/\s+/)[0]!).sort();
}

function expectedLabels(me: Me, from: Label): string[] {
  return LABELS.filter((to) => isVisible(me.clearance, to) && canChangeLabel(me.role, from, to)).sort();
}

describe('the create form validates with the shared schemas (criterion 4)', () => {
  it('shows a field error for an empty name and sends nothing', async () => {
    const { api, user } = renderApp('/risks/new');
    await findCreateForm();
    await user.click(submitButton());
    await waitFor(() => expect(field(/^name/i).getAttribute('aria-invalid')).toBe('true'));
    const describedBy = field(/^name/i).getAttribute('aria-describedby') ?? '';
    const messages = describedBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .filter(Boolean);
    expect(messages.length, 'the name field points at its error message').toBeGreaterThan(0);
    expect(api.callsTo('/api/v1/risks', 'POST')).toHaveLength(0);
  });

  it('shows a field error for a negative financial exposure and sends nothing', async () => {
    const { api, user } = renderApp('/risks/new');
    await findCreateForm();
    await setField(user, /^name/i, 'Supplier outage');
    await setField(user, /^impact/i, '3');
    await setField(user, /^likelihood/i, '2');
    await setField(user, /^financial exposure/i, '-5');
    await user.click(submitButton());
    await waitFor(() => expect(field(/^financial exposure/i).getAttribute('aria-invalid')).toBe('true'));
    expect(api.callsTo('/api/v1/risks', 'POST')).toHaveLength(0);
  });

  it('creates a risk with the fields typed and the owner picked', async () => {
    const { api, user } = renderApp('/risks/new');
    await findCreateForm();
    await setField(user, /^name/i, 'Supplier outage');
    await setField(user, /^impact/i, '4');
    await setField(user, /^likelihood/i, '3');
    await setField(user, /^financial exposure/i, '120000');
    await setField(user, /^owner/i, 'Priya Raman');
    await user.click(submitButton());

    await waitFor(() => expect(api.callsTo('/api/v1/risks', 'POST')).toHaveLength(1));
    const body = api.callsTo('/api/v1/risks', 'POST')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({
      name: 'Supplier outage',
      impact: 4,
      likelihood: 3,
      financialExposure: 120000,
      owner: 'user-priya',
    });
    await waitFor(() => expect(api.risks.some((r) => r.name === 'Supplier outage')).toBe(true));
  });
});

describe('the label chooser (criterion 4, D51, D198)', () => {
  it('never offers a label above the clearance on the create form', async () => {
    const { user } = renderApp('/risks/new', new RecordsApi({ me: RISK_MANAGER }));
    await findCreateForm();
    const offered = await labelOptions(user);
    expect(offered).toContain('internal');
    expect(offered).toContain('confidential');
    expect(offered).not.toContain('restricted');
  });

  it.each([
    ['a Risk manager (confidential) on an internal risk', RISK_MANAGER, 2, 'internal' as Label],
    [
      'a Risk manager (restricted) on a confidential risk',
      { ...RISK_MANAGER, clearance: 'restricted' as Label },
      1,
      'confidential' as Label,
    ],
    ['an Admin (restricted) on an internal risk', ADMIN, 2, 'internal' as Label],
    [
      'an Admin (confidential) on an internal risk',
      { ...ADMIN, clearance: 'confidential' as Label },
      2,
      'internal' as Label,
    ],
  ] as const)('offers only the allowed changes to %s', async (_who, me, n, from) => {
    const { user } = renderApp(`/risks/${riskId(n)}`, new RecordsApi({ me }));
    await openEditForm(user, riskId(n));
    expect(await labelOptions(user)).toEqual(expectedLabels(me, from));
  });
});

describe('the owner picker (criterion 4, D206)', () => {
  it('lists the org members from the people route on the create form', async () => {
    const { api, user } = renderApp('/risks/new');
    await findCreateForm();
    await waitFor(() => expect(api.callsTo('/api/v1/people').length).toBeGreaterThan(0));
    const shown = await optionsOf(user, field(/^owner/i));
    expect(shown).toHaveLength(PEOPLE.length);
    for (const person of PEOPLE)
      expect(
        shown.some((t) => t.includes(person.name)),
        person.name,
      ).toBe(true);
  });

  it.each([
    ['a Risk manager', RISK_MANAGER],
    ['an Admin', ADMIN],
  ] as const)('is on the edit form, open to %s, and changes the owner', async (_who, me) => {
    const { api, user } = renderApp(`/risks/${riskId(1)}`, new RecordsApi({ me }));
    await openEditForm(user, riskId(1));
    const owner = field(/^owner/i);
    expect(owner.hasAttribute('disabled')).toBe(false);
    expect(owner.getAttribute('aria-disabled')).not.toBe('true');
    expect(owner.getAttribute('aria-readonly')).not.toBe('true');
    const shown = await optionsOf(user, owner);
    for (const person of PEOPLE)
      expect(
        shown.some((t) => t.includes(person.name)),
        person.name,
      ).toBe(true);

    await setField(user, /^owner/i, 'Priya Raman');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() => expect(api.callsTo(`/api/v1/risks/${riskId(1)}`, 'PATCH')).toHaveLength(1));
    const body = api.callsTo(`/api/v1/risks/${riskId(1)}`, 'PATCH')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ owner: 'user-priya', version: 3 });
  });
});

describe('save sends the version (criterion 4, D69)', () => {
  it('sends the version the form was opened with, and the API accepts the body', async () => {
    const { api, user } = renderApp(`/risks/${riskId(1)}`);
    await openEditForm(user, riskId(1));
    await setField(user, /^name/i, 'Ransomware on all servers');
    await user.click(screen.getByRole('button', { name: /^save/i }));

    await waitFor(() => expect(api.callsTo(`/api/v1/risks/${riskId(1)}`, 'PATCH')).toHaveLength(1));
    const body = api.callsTo(`/api/v1/risks/${riskId(1)}`, 'PATCH')[0]!.body as Record<string, unknown>;
    expect(body).toMatchObject({ name: 'Ransomware on all servers', version: 3 });
    await waitFor(() => expect(api.risk(riskId(1))!.name).toBe('Ransomware on all servers'));
    expect(api.risk(riskId(1))!.version).toBe(4);
  });
});
