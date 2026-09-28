// M0-016 criterion 6 (D54, D60, D65, D114): a real sign-in through the front door.
// Through https://grc.localhost only: a demo user signs in, sets up MFA, sees the shell, signs out.
// A second demo user from the other org signs in and sees only their own org.
//
// Needs the whole stack (Caddy, API, Postgres, Neo4j) running, the DB migrated, `pnpm seed:demo`
// run, the hosts line `127.0.0.1 grc.localhost`, and Caddy's local root certificate trusted on the
// Mac (D65). The browser gets no certificate exceptions: an untrusted certificate fails the run.
import { expect, test, type Page, type Request } from '@playwright/test';
import { ACME_USER, GLOBEX_USER, ORIGIN, demoPassword, resetMfa, totpNow } from './helpers';

test.setTimeout(120_000);

type DemoUser = typeof ACME_USER;

/** Every request the page makes must go through the front door (no other host, no plain HTTP). */
function watchRequests(page: Page): string[] {
  const offDoor: string[] = [];
  page.on('request', (req: Request) => {
    const url = req.url();
    if (url.startsWith('data:') || url.startsWith('blob:')) return;
    if (!url.startsWith(`${ORIGIN}/`)) offDoor.push(url);
  });
  return offDoor;
}

async function signInWithPassword(page: Page, email: string): Promise<void> {
  await page.goto(`${ORIGIN}/`);
  // Signed out: the app sends the visitor to sign-in.
  await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(demoPassword());
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** The four MFA set-up steps: password, QR code, backup codes shown once, then a code from the app. */
async function setUpMfa(page: Page): Promise<void> {
  await expect(page).toHaveURL(`${ORIGIN}/mfa/setup`);
  await expect(page.getByRole('heading', { name: 'Set up two-factor sign-in' })).toBeVisible();

  await page.getByLabel('Password').fill(demoPassword());
  const enabled = page.waitForResponse(
    (res) => res.url() === `${ORIGIN}/api/v1/auth/two-factor/enable` && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Continue' }).click();
  const enrolment = (await (await enabled).json()) as { totpURI: string; backupCodes: string[] };
  expect(enrolment.totpURI).toMatch(/^otpauth:\/\/totp\//);
  expect(enrolment.backupCodes.length).toBeGreaterThan(0);

  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.getByText(enrolment.backupCodes[0]!, { exact: true })).toBeVisible();
  await page.getByLabel('I have saved these backup codes').check();
  await page.getByRole('button', { name: 'Continue' }).click();

  await page.getByLabel('Authentication code').fill(totpNow(enrolment.totpURI));
  await page.getByRole('button', { name: 'Verify and finish' }).click();
}

async function expectShellFor(page: Page, user: DemoUser): Promise<void> {
  await expect(page).toHaveURL(`${ORIGIN}/`);
  const header = page.getByRole('banner');
  await expect(header.getByText(user.org, { exact: true })).toBeVisible();
  await expect(header.getByText(user.name, { exact: true })).toBeVisible();
  await expect(header.getByText(user.role, { exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test('the app is served at https://grc.localhost with a certificate the browser trusts', async ({ page }) => {
  const res = await page.goto(`${ORIGIN}/`);
  expect(res?.ok()).toBe(true);
  expect(page.url().startsWith(`${ORIGIN}/`)).toBe(true);
});

test('http://grc.localhost sends the browser to https://grc.localhost', async ({ page }) => {
  await page.goto('http://grc.localhost/sign-in');
  await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
});

test('an Acme demo user signs in, sets up MFA, sees the shell and signs out', async ({ page }) => {
  resetMfa(ACME_USER.email);
  const offDoor = watchRequests(page);

  await signInWithPassword(page, ACME_USER.email);
  await setUpMfa(page);
  await expectShellFor(page, ACME_USER);

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/sign-in`);

  // The session is really gone: the shell sends the visitor back to sign-in, and the API says 401.
  await page.goto(`${ORIGIN}/`);
  await expect(page).toHaveURL(`${ORIGIN}/sign-in`);
  const me = await page.request.get(`${ORIGIN}/api/v1/me`);
  expect(me.status()).toBe(401);

  expect(offDoor).toEqual([]);
});

test('a Globex demo user signs in and sees only their own org', async ({ page }) => {
  resetMfa(GLOBEX_USER.email);
  const offDoor = watchRequests(page);

  await signInWithPassword(page, GLOBEX_USER.email);
  await setUpMfa(page);
  await expectShellFor(page, GLOBEX_USER);

  await expect(page.getByText(ACME_USER.org)).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Acme');

  const me = await page.request.get(`${ORIGIN}/api/v1/me`);
  expect(me.status()).toBe(200);
  const body = (await me.json()) as { org: { name: string } };
  expect(body.org.name).toBe(GLOBEX_USER.org);

  expect(offDoor).toEqual([]);
});
