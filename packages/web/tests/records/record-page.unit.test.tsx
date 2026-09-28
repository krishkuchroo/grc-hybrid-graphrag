// @vitest-environment jsdom
// S1-006 criterion 3: the record page shows every field, with the number as its title, the label
// badge, the owner and the dates. "Edit" and "Retire" show only when can(role, 'risk', 'edit')
// (D50, via @grc/shared). The web only hides buttons; the API decides (D7), so a 403 or 404 on a
// save or retire still shows a clear message.
import { screen, waitFor, within } from '@testing-library/react';
import { can, ROLES } from '@grc/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ADMIN,
  ANALYST,
  field,
  findDialog,
  findRegister,
  mainText,
  RecordsApi,
  renderApp,
  resetApp,
  RISK_MANAGER,
  riskId,
  setField,
  VIEWER,
  type Me,
} from './helpers';

afterEach(resetApp);

const RISK_1 = `/risks/${riskId(1)}`;

function editControl(): HTMLElement {
  const control = screen.queryByRole('button', { name: /^edit/i }) ?? screen.queryByRole('link', { name: /^edit/i });
  expect(control, 'an Edit button or link').toBeTruthy();
  return control!;
}

async function findTitle(): Promise<HTMLElement> {
  return screen.findByRole('heading', { level: 1, name: /RSK0001001/ });
}

describe('the record page (criterion 3)', () => {
  it('has the number as its title', async () => {
    renderApp(RISK_1);
    expect(await findTitle()).toBeTruthy();
  });

  it('shows every field: name, impact, likelihood, financial exposure, rating, status and origin', async () => {
    renderApp(RISK_1);
    await findTitle();
    const text = mainText();
    expect(text).toContain('Ransomware on the claims servers');
    expect(text).toMatch(/impact/i);
    expect(text).toMatch(/likelihood/i);
    expect(text).toMatch(/financial exposure/i);
    expect(text).toMatch(/250,?000/);
    expect(text).toMatch(/\b20\b/);
    expect(text).toMatch(/critical/i);
    expect(text).toMatch(/active/i);
    expect(text).toMatch(/manual/i);
  });

  it("shows the label badge, the owner's name and the created and updated dates", async () => {
    renderApp(RISK_1);
    await findTitle();
    const text = mainText();
    expect(screen.getAllByText(/^confidential$/i).length).toBeGreaterThan(0);
    expect(text).toContain('Dana Whitfield');
    expect(text).toMatch(/created/i);
    expect(text).toMatch(/updated/i);
    expect(text).toMatch(/2026/);
  });

  it('opens from the register by clicking the number', async () => {
    const { user } = renderApp('/risks');
    const table = await findRegister();
    await user.click(within(table).getByRole('link', { name: /RSK0001001/ }));
    expect(await findTitle()).toBeTruthy();
    expect(window.location.pathname).toBe(RISK_1);
  });
});

function withRole(role: string): Me {
  return { id: `user-${role}`, name: `Test ${role}`, role, clearance: 'restricted' };
}

describe('Edit and Retire follow the role table (criterion 3, D50)', () => {
  it.each(ROLES.map((role) => [role, can(role, 'risk', 'edit')] as const))(
    '%s: Edit and Retire shown = %s',
    async (role, allowed) => {
      renderApp(RISK_1, new RecordsApi({ me: withRole(role) }));
      await findTitle();
      const edit = screen.queryByRole('button', { name: /^edit/i }) ?? screen.queryByRole('link', { name: /^edit/i });
      const retire = screen.queryByRole('button', { name: /^retire/i });
      expect(edit !== null, 'Edit shown').toBe(allowed);
      expect(retire !== null, 'Retire shown').toBe(allowed);
    },
  );

  it.each([
    ['an editor (Risk manager)', true, RISK_MANAGER],
    ['an editor (Admin)', true, ADMIN],
    ['a viewer (Analyst)', false, ANALYST],
    ['a viewer (Viewer)', false, VIEWER],
  ] as const)('%s: the register offers a new risk = %s', async (_who, allowed, me) => {
    renderApp('/risks', new RecordsApi({ me }));
    await findRegister();
    const create =
      screen.queryByRole('link', { name: /new risk/i }) ?? screen.queryByRole('button', { name: /new risk/i });
    expect(create !== null).toBe(allowed);
  });
});

describe("the API's refusal still shows when the buttons were wrong (criterion 3, D7)", () => {
  it("shows the API's 403 message when a retire is refused", async () => {
    const api = new RecordsApi({ me: RISK_MANAGER });
    api.fail('POST', /\/retire$/, {
      status: 403,
      code: 'forbidden',
      message: 'You may not do this.',
      referenceId: 'ref-retire-403-5be1',
    });
    const { user } = renderApp(RISK_1, api);
    await findTitle();
    await user.click(screen.getByRole('button', { name: /^retire/i }));
    const dialog = await findDialog();
    await user.click(within(dialog).getByRole('button', { name: /retire/i }));
    await screen.findByText(/You may not do this\./);
    expect(document.body.textContent).toContain('ref-retire-403-5be1');
  });

  it("shows the API's 403 message when a save is refused", async () => {
    const api = new RecordsApi({ me: RISK_MANAGER });
    api.fail('PATCH', /^\/api\/v1\/risks\/[^/]+$/, {
      status: 403,
      code: 'forbidden',
      message: 'You may not do this.',
      referenceId: 'ref-save-403-c09d',
    });
    const { user } = renderApp(RISK_1, api);
    await findTitle();
    await user.click(editControl());
    await waitFor(() => field(/^name/i));
    await setField(user, /^name/i, 'Ransomware on all servers');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await screen.findByText(/You may not do this\./);
    expect(document.body.textContent).toContain('ref-save-403-c09d');
  });

  it('shows a clear message when a save meets a 404', async () => {
    const api = new RecordsApi({ me: RISK_MANAGER });
    api.fail('PATCH', /^\/api\/v1\/risks\/[^/]+$/, {
      status: 404,
      code: 'not_found',
      message: 'The record was not found.',
      referenceId: 'ref-save-404-e2a0',
    });
    const { user } = renderApp(RISK_1, api);
    await findTitle();
    await user.click(editControl());
    await waitFor(() => field(/^name/i));
    await setField(user, /^name/i, 'Ransomware on all servers');
    await user.click(screen.getByRole('button', { name: /^save/i }));
    await waitFor(() =>
      expect(document.body.textContent).toMatch(/doesn.t exist or you can.t see it|The record was not found\./),
    );
  });
});
