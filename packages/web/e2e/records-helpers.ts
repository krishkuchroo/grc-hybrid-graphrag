// S1-010: helpers for the records journeys through the front door (D60, D114, D172).
// Each journey signs in fresh as a demo user from `pnpm seed:demo`: its two-factor set-up is
// cleared first (resetMfa), then set up again through the app, as in sign-in.e2e.ts. So a run of
// these tests clears the MFA of the demo logins it uses; the person doing the demo just sets it up
// again at their next sign-in.
import { expect, type Page } from '@playwright/test';
import { ORIGIN, demoPassword, resetMfa, totpNow } from './helpers';

export const ACME = {
  admin: 'admin@acme.example',
  riskManager: 'risk.manager@acme.example',
  controlOwner: 'control.owner@acme.example',
  viewer: 'viewer@acme.example',
};
export const GLOBEX = { viewer: 'viewer@globex.example' };

/** The one answer for a record that is missing or hidden (S1-006, D47). */
export const NOT_FOUND_TEXT = "This record doesn't exist or you can't see it.";
export const RISK_NUMBER = /^RSK\d{7}$/;
export const CONTROL_NUMBER = /^CTL\d{7}$/;

/** Signs in through the app with the demo password and sets up MFA, ending on the home page. */
export async function signIn(page: Page, email: string): Promise<void> {
  resetMfa(email);
  await page.goto(`${ORIGIN}/sign-in`);
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill(demoPassword());
  await page.getByRole('button', { name: 'Sign in' }).click();

  await expect(page).toHaveURL(`${ORIGIN}/mfa/setup`);
  await page.getByLabel('Password').fill(demoPassword());
  const enabled = page.waitForResponse(
    (res) => res.url() === `${ORIGIN}/api/v1/auth/two-factor/enable` && res.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Continue' }).click();
  const enrolment = (await (await enabled).json()) as { totpURI: string };
  await expect(page.getByRole('img', { name: 'QR code for your authenticator app' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('I have saved these backup codes').check();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Authentication code').fill(totpNow(enrolment.totpURI));
  await page.getByRole('button', { name: 'Verify and finish' }).click();
  await expect(page).toHaveURL(`${ORIGIN}/`);
}

export interface ApiAnswer<T> {
  status: number;
  body: T;
}

/** A call to the API from inside the page (same origin, the page's session cookie). */
export async function api<T = Record<string, unknown>>(
  page: Page,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<ApiAnswer<T>> {
  return page.evaluate(
    async ({ method, path, body }) => {
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? {} : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const parsed: unknown = await res.json().catch(() => null);
      return { status: res.status, body: parsed as never };
    },
    { method, path, body },
  );
}

export interface RecordOut {
  id: string;
  number: string;
  name: string;
  owner: string;
  label: string;
  version: number;
}

export interface Paged<T> {
  items: T[];
  total: number;
}

/** A risk made through the API for one journey, with a name no other run uses. */
export async function newRisk(page: Page, tag: string): Promise<RecordOut> {
  const created = await api<RecordOut>(page, 'POST', '/api/v1/risks', {
    name: `E2E ${tag} ${Date.now()}`,
    impact: 2,
    likelihood: 3,
    financialExposure: 1000,
  });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  return created.body;
}

/** Retires a risk a journey made, so the demo register stays as the seed left it. */
export async function retireRisk(page: Page, id: string): Promise<void> {
  const now = await api<RecordOut>(page, 'GET', `/api/v1/risks/${id}`);
  if (now.status !== 200) return;
  const retired = await api(page, 'POST', `/api/v1/risks/${id}/retire`, { version: now.body.version });
  expect(retired.status, JSON.stringify(retired.body)).toBe(200);
}

/**
 * On a risk's page: "Add link" → "Controls that treat this risk" → search → the first control
 * offered → "Add link". Returns the linked control's number.
 */
export async function linkFirstControl(page: Page, skip: string[] = []): Promise<string> {
  await page.getByRole('button', { name: 'Add link' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Link type').selectOption({ label: 'Controls that treat this risk' });
  await dialog.getByLabel('Search').fill('CTL');
  const offered = dialog.getByRole('list', { name: 'Matching controls' }).getByRole('button');
  await expect(offered.first()).toBeVisible();
  let number = '';
  for (const option of await offered.all()) {
    const found = /CTL\d{7}/.exec(await option.innerText())?.[0] ?? '';
    if (found !== '' && !skip.includes(found)) {
      number = found;
      await option.click();
      break;
    }
  }
  expect(number, 'no control was offered to link').not.toBe('');
  await dialog.getByRole('button', { name: 'Add link' }).click();
  await expect(dialog).toBeHidden();
  return number;
}

/** The "Controls that treat this risk" group on a risk's page. */
export function treatingControls(page: Page) {
  return page.getByRole('region', { name: 'Controls that treat this risk' });
}
