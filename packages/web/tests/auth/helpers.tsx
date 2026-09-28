// Shared set-up for the M0-015 web auth tests.
//
// The API is mocked at the client boundary: `fetch` is replaced by a small fake of the real API
// (M0-007 error format, M0-010 Better Auth routes and GET /api/v1/me), so the generated typed
// client runs for real and every request it makes is recorded.
//
// Contract with the app (M0-015 brief):
// - `src/app/App.tsx` exports `App`, the whole app (query client, router, pages). Each mount builds
//   its own router and query client and reads the current `window.location` (browser history).
// - The sign-in page lives at `/sign-in`. Signed-out visits to other pages end up there.
// - Moving between screens in the shell checks the session again (GET /api/v1/me), so a 401 on an
//   expired session is noticed on the next click.
import { act, cleanup, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, vi } from 'vitest';
import { App } from '../../src/app/App';

configure({ asyncUtilTimeout: 3000 });

export interface FakeUser {
  id: string;
  email: string;
  password: string;
  name: string;
  org: { id: string; name: string };
  role: string;
  clearance: string;
  mfaEnrolled: boolean;
}

export const TOTP_CODE = '482913';
export const TOTP_URI = 'otpauth://totp/GRC:dana%40northwind.test?secret=JBSWY3DPEHPK3PXP&issuer=GRC';
export const BACKUP_CODES = [
  'q7Hk2-Mv9Lp',
  'Zr4Tn-8wXcB',
  'aP3yD-6sQeK',
  'Lm8Vb-1nRtG',
  'uW5cJ-9hEzF',
  'Xk2Pq-7aYdN',
  'Gt6Rm-3bUwS',
  'Hs9Lc-4vKjA',
  'Nd1Fy-5eMxZ',
  'Bp7Wq-2oTgC',
];

// Two orgs, so a sign-out followed by another user's sign-in can show a leak between them.
export const MFA_USER: FakeUser = {
  id: 'user-dana',
  email: 'dana@northwind.test',
  password: 'correct-horse-battery',
  name: 'Dana Whitfield',
  org: { id: 'org-northwind', name: 'Northwind Health' },
  role: 'risk_manager',
  clearance: 'confidential',
  mfaEnrolled: true,
};

export const NEW_USER: FakeUser = {
  id: 'user-omar',
  email: 'omar@northwind.test',
  password: 'staple-lantern-orbit',
  name: 'Omar Haddad',
  org: { id: 'org-northwind', name: 'Northwind Health' },
  role: 'analyst',
  clearance: 'internal',
  mfaEnrolled: false,
};

export const OTHER_ORG_USER: FakeUser = {
  id: 'user-lena',
  email: 'lena@contoso.test',
  password: 'granite-meadow-signal',
  name: 'Lena Varga',
  org: { id: 'org-contoso', name: 'Contoso Energy' },
  role: 'compliance_manager',
  clearance: 'restricted',
  mfaEnrolled: true,
};

export interface RecordedCall {
  /** What the app passed to fetch, as a string (a relative path stays relative). */
  raw: string;
  /** The same, resolved against the page's address. */
  url: URL;
  method: string;
  body: unknown;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

let refCounter = 0;
function apiError(status: number, code: string, message: string, headers: Record<string, string> = {}): Response {
  refCounter += 1;
  return json(status, { error: { code, message, referenceId: `ref-${refCounter}` } }, headers);
}

async function readBody(input: RequestInfo | URL, init?: RequestInit): Promise<unknown> {
  let text: string | undefined;
  if (init?.body !== undefined && init.body !== null) {
    text = typeof init.body === 'string' ? init.body : await new Response(init.body).text();
  } else if (typeof input === 'object' && 'clone' in input && typeof input.clone === 'function') {
    text = await (input as Request).clone().text();
  }
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A fake of the API behind the typed client. */
export class FakeApi {
  readonly calls: RecordedCall[] = [];
  private readonly users: FakeUser[];
  private session: { user: FakeUser; mfaVerified: boolean } | null = null;
  private pendingSecondFactor: FakeUser | null = null;
  private enrolling = false;
  /** When set, sign-in answers 429 like the API's 5-failure lock. */
  lockedSeconds: number | null = null;

  constructor(users: FakeUser[] = [MFA_USER, NEW_USER, OTHER_ORG_USER]) {
    this.users = users.map((u) => ({ ...u }));
  }

  /** The server ends the session (30 min idle); the browser doesn't know yet. */
  expireSession(): void {
    this.session = null;
  }

  /** Starts with a live session, as if the page were reloaded while signed in. */
  startSession(email: string, mfaVerified: boolean): void {
    this.session = { user: this.user(email)!, mfaVerified };
  }

  user(email: string): FakeUser | undefined {
    return this.users.find((u) => u.email === email);
  }

  callsTo(path: string, method = 'POST'): RecordedCall[] {
    return this.calls.filter((c) => c.url.pathname === path && c.method === method);
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ?? (typeof input === 'object' && 'method' in input ? input.method : 'GET')
    ).toUpperCase();
    const url = new URL(raw, window.location.href);
    const body = await readBody(input, init);
    this.calls.push({ raw, url, method, body });
    return this.handle(method, url.pathname, (body ?? {}) as Record<string, unknown>);
  };

  private signedInAs(user: FakeUser, mfaVerified: boolean): Response {
    this.session = { user, mfaVerified };
    this.pendingSecondFactor = null;
    return json(200, {
      token: `token-${user.id}`,
      user: { id: user.id, email: user.email, name: user.name, twoFactorEnabled: user.mfaEnrolled },
    });
  }

  private handle(method: string, path: string, body: Record<string, unknown>): Response {
    const key = `${method} ${path}`;
    switch (key) {
      case 'POST /api/v1/auth/sign-in/email': {
        if (this.lockedSeconds !== null) {
          const minutes = Math.ceil(this.lockedSeconds / 60);
          return apiError(429, 'account_locked', `Too many failed sign-ins. Try again in ${minutes} min.`, {
            'retry-after': String(this.lockedSeconds),
          });
        }
        const user = typeof body.email === 'string' ? this.user(body.email.toLowerCase()) : undefined;
        if (!user || body.password !== user.password) {
          return apiError(401, 'invalid_email_or_password', 'Invalid email or password');
        }
        if (user.mfaEnrolled) {
          this.pendingSecondFactor = user;
          return json(200, { twoFactorRedirect: true });
        }
        return this.signedInAs(user, false);
      }
      case 'GET /api/v1/me': {
        if (!this.session) return apiError(401, 'unauthorized', 'Sign in first.');
        const u = this.session.user;
        return json(200, {
          user: { id: u.id, email: u.email, name: u.name },
          org: u.org,
          role: u.role,
          clearance: u.clearance,
          mfaEnrolled: u.mfaEnrolled,
        });
      }
      case 'POST /api/v1/auth/two-factor/enable': {
        if (!this.session) return apiError(401, 'unauthorized', 'Sign in first.');
        if (body.password !== this.session.user.password) {
          return apiError(400, 'invalid_password', 'Invalid password');
        }
        this.enrolling = true;
        return json(200, { totpURI: TOTP_URI, backupCodes: BACKUP_CODES });
      }
      case 'POST /api/v1/auth/two-factor/verify-totp': {
        if (body.code !== TOTP_CODE) return apiError(401, 'invalid_code', 'Invalid code');
        if (this.session && this.enrolling) {
          this.session.user.mfaEnrolled = true;
          this.enrolling = false;
          return this.signedInAs(this.session.user, true);
        }
        if (this.pendingSecondFactor) return this.signedInAs(this.pendingSecondFactor, true);
        return apiError(401, 'invalid_two_factor_cookie', 'Invalid two factor cookie');
      }
      case 'POST /api/v1/auth/two-factor/verify-backup-code': {
        if (!this.pendingSecondFactor) return apiError(401, 'invalid_two_factor_cookie', 'Invalid two factor cookie');
        if (typeof body.code !== 'string' || !BACKUP_CODES.includes(body.code)) {
          return apiError(401, 'invalid_backup_code', 'Invalid backup code');
        }
        return this.signedInAs(this.pendingSecondFactor, true);
      }
      case 'POST /api/v1/auth/sign-out': {
        this.session = null;
        return json(200, { success: true });
      }
      default:
        return apiError(404, 'not_found', 'Not found.');
    }
  }
}

export type User = ReturnType<typeof userEvent.setup>;

/** Installs the fake API as `fetch`, opens the app at `path`, and returns the pieces. */
export function renderApp(path: string, api = new FakeApi()): { api: FakeApi; user: User } {
  vi.stubGlobal('fetch', api.fetch);
  window.history.replaceState(null, '', path);
  const user = userEvent.setup();
  render(<App />);
  return { api, user };
}

export function resetApp(): void {
  cleanup();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
}

export async function waitForPath(path: string): Promise<void> {
  await waitFor(() => expect(window.location.pathname).toBe(path));
}

export async function findSignInForm(): Promise<{ email: HTMLElement; password: HTMLElement; submit: HTMLElement }> {
  const submit = await screen.findByRole('button', { name: /^sign in$/i });
  return {
    email: screen.getByLabelText(/^email/i),
    password: screen.getByLabelText(/^password/i),
    submit,
  };
}

export async function submitSignIn(user: User, email: string, password: string): Promise<void> {
  const form = await findSignInForm();
  await user.clear(form.email);
  await user.type(form.email, email);
  await user.clear(form.password);
  await user.type(form.password, password);
  await user.click(form.submit);
}

/** The 6-digit check shown to a user who already has MFA. */
export async function findCodeInput(): Promise<HTMLElement> {
  return screen.findByRole('textbox', { name: /code/i });
}

export async function passSecondFactor(user: User, code = TOTP_CODE): Promise<void> {
  const input = await findCodeInput();
  await user.type(input, code);
  await user.click(screen.getByRole('button', { name: /verify|confirm|continue/i }));
}

/** Signs a user with MFA all the way into the shell. */
export async function signInFully(user: User, who: FakeUser): Promise<HTMLElement> {
  await submitSignIn(user, who.email, who.password);
  await passSecondFactor(user);
  return findBanner(who);
}

/** The shell's header, once it shows `who`'s org. */
export async function findBanner(who: FakeUser): Promise<HTMLElement> {
  return waitFor(() => {
    const banner = screen.getByRole('banner');
    within(banner).getByText(new RegExp(who.org.name));
    return banner;
  });
}

export async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}
