// S1-010 criterion 5 (D114, D172, D50, D51, D55, D69, D200, D201): the S1 journeys in a real browser,
// through https://grc.localhost only, as the users `pnpm seed:demo` made, over the records it seeded.
//
// Needs the whole stack running with this task's API and web code, the DB migrated, `pnpm seed:demo`
// run (records and links included), the hosts line and Caddy's trusted root (as sign-in.e2e.ts).
// Each journey signs in fresh (records-helpers.ts) and makes its own risks, which it retires at the
// end, so no journey relies on another's data and the seeded register stays as it was.
import { expect, test, type Page } from '@playwright/test';
import { ORIGIN } from './helpers';
import {
  ACME,
  CONTROL_NUMBER,
  GLOBEX,
  NOT_FOUND_TEXT,
  RISK_NUMBER,
  api,
  linkFirstControl,
  newRisk,
  retireRisk,
  signIn,
  treatingControls,
  type Paged,
  type RecordOut,
} from './records-helpers';

test.setTimeout(180_000);

interface LinkItem {
  type: string;
  other: { id: string; number: string };
}

async function linksOf(page: Page, riskId: string): Promise<LinkItem[]> {
  const res = await api<{ items: LinkItem[] }>(page, 'GET', `/api/v1/risks/${riskId}/links`);
  expect(res.status).toBe(200);
  return res.body.items;
}

async function expectNotFoundPage(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Record not found' })).toBeVisible();
  await expect(page.getByText(NOT_FOUND_TEXT)).toBeVisible();
}

test('the Risk Manager creates a risk, sees its rating, and links a control', async ({ page }) => {
  await signIn(page, ACME.riskManager);
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Risk register' }).click();
  await expect(page).toHaveURL(new RegExp(`^${ORIGIN}/risks`));
  await page.getByRole('link', { name: 'New risk' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/risks/new`);

  const name = `E2E new risk ${Date.now()}`;
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Impact').selectOption('4');
  await page.getByLabel('Likelihood').selectOption('5');
  await page.getByLabel('Financial exposure').fill('250000');
  await page.getByRole('button', { name: 'Create risk' }).click();

  await expect(page).toHaveURL(/\/risks\/[0-9a-f-]{36}$/);
  const riskId = page.url().split('/').pop()!;
  try {
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(RISK_NUMBER);
    await expect(page.getByText(name).first()).toBeVisible();
    // D197: 4 x 5 = 20, critical.
    const rating = page.getByRole('region', { name: 'Rating' });
    await expect(rating).toContainText('20');
    await expect(rating).toContainText('Critical');

    const control = await linkFirstControl(page);
    expect(control).toMatch(CONTROL_NUMBER);
    await expect(treatingControls(page).getByRole('link', { name: control })).toBeVisible();

    await page.reload();
    await expect(treatingControls(page).getByRole('link', { name: control })).toBeVisible();
    expect((await linksOf(page, riskId)).map((l) => l.other.number)).toContain(control);
  } finally {
    await retireRisk(page, riskId);
  }
});

test('the Risk Manager links a wrong control and removes it again; it is gone after a reload (D201)', async ({
  page,
}) => {
  await signIn(page, ACME.riskManager);
  const risk = await newRisk(page, 'wrong link');
  try {
    await page.goto(`${ORIGIN}/risks/${risk.id}`);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(risk.number);

    const wrong = await linkFirstControl(page);
    const row = treatingControls(page).getByRole('link', { name: wrong });
    await expect(row).toBeVisible();

    await page.getByRole('button', { name: `Remove link to ${wrong}` }).click();
    const confirm = page.getByRole('alertdialog');
    await expect(confirm).toContainText(wrong);
    await confirm.getByRole('button', { name: 'Remove link' }).click();
    await expect(confirm).toBeHidden();
    await expect(page.getByText(`Link to ${wrong}`)).toBeVisible();
    await expect(row).toHaveCount(0);

    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(risk.number);
    await expect(treatingControls(page)).toBeVisible();
    await expect(treatingControls(page).getByRole('link', { name: wrong })).toHaveCount(0);
    expect((await linksOf(page, risk.id)).map((l) => l.other.number)).not.toContain(wrong);
  } finally {
    await retireRisk(page, risk.id);
  }
});

test('the Viewer sees the register, with no New risk or Edit button', async ({ page }) => {
  await signIn(page, ACME.viewer);
  await page.goto(`${ORIGIN}/risks`);
  const first = page.getByRole('link', { name: RISK_NUMBER }).first();
  await expect(first).toBeVisible();
  await expect(page.getByRole('link', { name: 'New risk' })).toHaveCount(0);

  const number = (await first.innerText()).trim();
  await first.click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(number);
  await expect(page.getByRole('region', { name: 'Details' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Edit' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Retire/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add link' })).toHaveCount(0);
});

test('the Control Owner sees only their own controls and edits one', async ({ page }) => {
  await signIn(page, ACME.controlOwner);
  const me = await api<{ user: { id: string } }>(page, 'GET', '/api/v1/me');
  expect(me.status).toBe(200);
  const listed = await api<Paged<RecordOut>>(page, 'GET', '/api/v1/controls?pageSize=100');
  expect(listed.status).toBe(200);
  expect(listed.body.total).toBeGreaterThanOrEqual(3);
  for (const c of listed.body.items) expect(c.owner, `${c.number} is not theirs`).toBe(me.body.user.id);

  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Controls' }).click();
  await expect(page).toHaveURL(new RegExp(`^${ORIGIN}/controls`));
  const shown = page.getByRole('link', { name: CONTROL_NUMBER });
  await expect(shown.first()).toBeVisible();
  const numbers = (await shown.allInnerTexts()).map((t) => t.trim()).sort();
  expect(numbers).toEqual(listed.body.items.map((c) => c.number).sort());

  const control = listed.body.items[0]!;
  await page.getByRole('link', { name: control.number }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(control.number);
  await page.getByRole('button', { name: 'Edit' }).click();
  const edited = `${control.name} (reviewed ${Date.now()})`;
  try {
    await page.getByLabel('Name').fill(edited);
    await page.getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByText('Changes saved.')).toBeVisible();
    await expect(page.getByText(edited).first()).toBeVisible();
    const after = await api<RecordOut>(page, 'GET', `/api/v1/controls/${control.id}`);
    expect(after.body.name).toBe(edited);
    expect(after.body.version).toBe(control.version + 1);
  } finally {
    // Put the seeded name back, so the demo data stays as the seed left it.
    const now = await api<RecordOut>(page, 'GET', `/api/v1/controls/${control.id}`);
    if (now.status === 200 && now.body.name !== control.name) {
      await api(page, 'PATCH', `/api/v1/controls/${control.id}`, { name: control.name, version: now.body.version });
    }
  }
});

test('a stale save in two browser contexts shows the message (D69)', async ({ browser }) => {
  const first = await browser.newContext();
  const a = await first.newPage();
  await signIn(a, ACME.riskManager);
  const second = await browser.newContext({ storageState: await first.storageState() });
  const b = await second.newPage();
  const risk = await newRisk(a, 'stale save');
  try {
    for (const page of [a, b]) {
      await page.goto(`${ORIGIN}/risks/${risk.id}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(risk.number);
      await page.getByRole('button', { name: 'Edit' }).click();
    }

    await a.getByLabel('Name').fill(`${risk.name} (first tab)`);
    await a.getByRole('button', { name: 'Save changes' }).click();
    await expect(a.getByText('Changes saved.')).toBeVisible();

    await b.getByLabel('Name').fill(`${risk.name} (second tab)`);
    await b.getByRole('button', { name: 'Save changes' }).click();
    await expect(b.getByRole('alert').filter({ hasText: 'This record changed since you opened it' })).toBeVisible();
    await expect(b.getByLabel('Name')).toHaveValue(`${risk.name} (second tab)`);

    const saved = await api<RecordOut>(a, 'GET', `/api/v1/risks/${risk.id}`);
    expect(saved.body.name).toBe(`${risk.name} (first tab)`);
  } finally {
    await retireRisk(a, risk.id);
    await second.close();
    await first.close();
  }
});

test('a Globex user opening an Acme risk URL gets the "doesn\'t exist or you can\'t see it" page', async ({
  browser,
}) => {
  const acmeContext = await browser.newContext();
  const acme = await acmeContext.newPage();
  await signIn(acme, ACME.viewer);
  const listed = await api<Paged<RecordOut>>(acme, 'GET', '/api/v1/risks?pageSize=1');
  expect(listed.status).toBe(200);
  const risk = listed.body.items[0]!;
  expect(risk.number).toMatch(RISK_NUMBER);
  await acmeContext.close();

  const globexContext = await browser.newContext();
  const globex = await globexContext.newPage();
  try {
    await signIn(globex, GLOBEX.viewer);
    await globex.goto(`${ORIGIN}/risks/${risk.id}`);
    await expectNotFoundPage(globex);
    await expect(globex.locator('body')).not.toContainText(risk.name);
    const direct = await api(globex, 'GET', `/api/v1/risks/${risk.id}`);
    expect(direct.status).toBe(404);
  } finally {
    await globexContext.close();
  }
});

test("an internal-clearance user doesn't see a restricted risk", async ({ browser }) => {
  const adminContext = await browser.newContext();
  const admin = await adminContext.newPage();
  await signIn(admin, ACME.admin);
  const restricted = await api<Paged<RecordOut>>(admin, 'GET', '/api/v1/risks?label=restricted&pageSize=100');
  expect(restricted.status).toBe(200);
  expect(restricted.body.total, 'the seed made no restricted risk').toBeGreaterThanOrEqual(1);
  const risk = restricted.body.items[0]!;
  expect(risk.label).toBe('restricted');
  await adminContext.close();

  const ownerContext = await browser.newContext();
  const page = await ownerContext.newPage();
  try {
    await signIn(page, ACME.controlOwner); // clearance internal (M0-014)
    const me = await api<{ clearance: string }>(page, 'GET', '/api/v1/me');
    expect(me.body.clearance).toBe('internal');

    await page.goto(`${ORIGIN}/risks`);
    await expect(page.getByRole('link', { name: RISK_NUMBER }).first()).toBeVisible();
    await expect(page.getByRole('link', { name: risk.number })).toHaveCount(0);

    await page.goto(`${ORIGIN}/risks?q=${risk.number}`);
    await expect(page.getByText('No risks match these filters.')).toBeVisible();
    await expect(page.getByRole('link', { name: risk.number })).toHaveCount(0);
    const searched = await api<Paged<RecordOut>>(page, 'GET', `/api/v1/risks?q=${risk.number}`);
    expect(searched.body.total).toBe(0);

    await page.goto(`${ORIGIN}/risks/${risk.id}`);
    await expectNotFoundPage(page);
    await expect(page.locator('body')).not.toContainText(risk.name);
  } finally {
    await ownerContext.close();
  }
});
