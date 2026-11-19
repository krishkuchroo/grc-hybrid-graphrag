// The dev auto-login switch (D264): with `DEV_AUTO_LOGIN=<email>` in .env, the API signs that one
// account straight in on this Mac, with no password and no MFA. It is the user's explicit choice
// and weakens D49/D54's "MFA for everyone" locally while the setting is on.
//
// - The setting is read once, by the API only (the worker never gets it). Unset or empty: off,
//   nothing logged. A value that doesn't look like an email is ignored with a warning.
// - At start-up, once the database answers, the account must exist and have a membership with a
//   known role and clearance; otherwise the switch is ignored with a warning. When it is on, one
//   loud warning names the user ID. The email is never logged or sent back.
// - GET /api/v1/auth/dev-auto-login answers `{ on }` and changes nothing.
// - POST /api/v1/auth/dev-auto-login (404 when off) needs Origin exactly TRUSTED_ORIGIN,
//   Content-Type application/json and no cross-site Sec-Fetch-Site, so no other website can start
//   it. It checks the account again, then makes a real Better Auth session through the server-only
//   plugin endpoint below: Better Auth's own session row and its own signed session cookie, exactly
//   as a normal sign-in sets them. The session-create hook in auth.ts marks only this session as
//   past MFA, and only while the switch is on. Its active org is the account's oldest membership.
//   The sign-in is audited as `auth.sign_in` with `{ method: 'dev_auto_login' }` in each org.
// The idle and 12 h limits (AuthService.resolveSession), roles, the org wall, labels, API keys and
// every other account are untouched. Removing the setting and restarting the API turns it off.
import type { BetterAuthPlugin } from 'better-auth';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import { errorKind, sendError } from '../common/errors.js';
import { TRUSTED_ORIGIN, type AuthService, type DevAutoLoginHooks } from './auth.js';

/** The route under /api/v1/auth, reached through the auth catch-all (auth-routes.ts). */
export const DEV_AUTO_LOGIN_ROUTE = '/dev-auto-login';
/** The plugin endpoint that makes the session. Server-only: Better Auth's router never serves it. */
export const DEV_SESSION_ENDPOINT_PATH = '/dev-auto-login/session';
const DEV_SESSION_ENDPOINT_KEY = 'grcDevAutoLoginSession';

const MIN_EMAIL_LENGTH = 3;
const MAX_EMAIL_LENGTH = 254;

export type DevAutoLoginSetting = { state: 'off' } | { state: 'bad_value' } | { state: 'set'; email: string };

/** Reads the setting: unset or empty is off; else trimmed and lowercased, one "@", 3 to 254 characters. */
export function readDevAutoLoginSetting(raw: string | undefined): DevAutoLoginSetting {
  const value = (raw ?? '').trim().toLowerCase();
  if (!value) return { state: 'off' };
  const ats = value.split('@').length - 1;
  if (ats !== 1 || value.length < MIN_EMAIL_LENGTH || value.length > MAX_EMAIL_LENGTH) return { state: 'bad_value' };
  return { state: 'set', email: value };
}

export type DevAccountCheck =
  { ok: true; userId: string; orgId: string } | { ok: false; reason: 'unknown_account' | 'no_membership' };

type DevSessionCall = (input: {
  headers: Headers;
  body: { activeOrganizationId: string };
  returnHeaders: true;
}) => Promise<{ headers: Headers | null | undefined; response: unknown }>;

export class DevAutoLogin implements DevAutoLoginHooks {
  // Set only by a passed start-up check: the switch is on exactly while this holds a user ID.
  private userId: string | null = null;

  private constructor(private readonly email: string | null) {}

  /** The switch as the API reads it at start. Logs `dev_auto_login_ignored` for a bad value. */
  static fromEnv(raw: string | undefined, log: Logger): DevAutoLogin {
    const setting = readDevAutoLoginSetting(raw);
    if (setting.state === 'bad_value') {
      log.warn({ code: 'dev_auto_login_ignored', reason: 'bad_value' }, 'DEV_AUTO_LOGIN ignored');
    }
    return new DevAutoLogin(setting.state === 'set' ? setting.email : null);
  }

  /** The switch off: what every program and test gets unless the API reads a valid setting. */
  static off(): DevAutoLogin {
    return new DevAutoLogin(null);
  }

  get on(): boolean {
    return this.userId !== null;
  }

  /** Better Auth's plugin with the session endpoint, only when the setting holds an email. */
  plugin(): BetterAuthPlugin | null {
    if (this.email === null) return null;
    const onUserId = (): string | null => this.userId;
    return {
      id: 'grc-dev-auto-login',
      endpoints: {
        [DEV_SESSION_ENDPOINT_KEY]: createAuthEndpoint(
          DEV_SESSION_ENDPOINT_PATH,
          {
            method: 'POST',
            body: z.object({ activeOrganizationId: z.string().min(1) }),
            // Never routed over HTTP: only our POST handler calls it, after its checks.
            metadata: { SERVER_ONLY: true },
          },
          async (ctx) => {
            const userId = onUserId();
            if (!userId) throw new APIError('FORBIDDEN', { message: 'Dev auto-login is off.' });
            const user = await ctx.context.internalAdapter.findUserById(userId);
            if (!user) throw new APIError('FORBIDDEN', { message: 'Dev auto-login is unavailable.' });
            // As the password sign-in does (`rememberMe` not false): the session's full 12 h expiry.
            const session = await ctx.context.internalAdapter.createSession(user.id, false, {
              activeOrganizationId: ctx.body.activeOrganizationId,
            });
            if (!session) throw new APIError('INTERNAL_SERVER_ERROR', { message: 'The session could not be made.' });
            await setSessionCookie(ctx, { session, user }, false);
            return ctx.json({ ok: true });
          },
        ),
      },
    };
  }

  /** The session-create hook's exception (auth.ts): only the dev endpoint, only while on. */
  verifiesMfa(path: string): boolean {
    return path === DEV_SESSION_ENDPOINT_PATH && this.on;
  }

  /** The account behind the setting: it exists and has a membership; its oldest org. */
  async checkAccount(auth: AuthService): Promise<DevAccountCheck> {
    if (this.email === null) return { ok: false, reason: 'unknown_account' };
    const userId = await auth.userIdByEmail(this.email);
    if (!userId) return { ok: false, reason: 'unknown_account' };
    const memberships = await auth.memberships(userId);
    const oldest = memberships[0];
    if (!oldest) return { ok: false, reason: 'no_membership' };
    return { ok: true, userId, orgId: oldest.orgId };
  }

  /** Run once at API start, after the database answers. Turns the switch on, or warns why not. */
  async startupCheck(auth: AuthService, log: Logger): Promise<void> {
    if (this.email === null) return;
    let found: DevAccountCheck;
    try {
      found = await this.checkAccount(auth);
    } catch (err) {
      // Fail safe: an account that can't be checked stays signed out. Only the error's type and
      // code are logged: a failed query's text can carry its parameters, the email among them (D163).
      log.warn({ code: 'dev_auto_login_ignored', reason: 'check_failed', ...errorKind(err) }, 'DEV_AUTO_LOGIN ignored');
      return;
    }
    if (!found.ok) {
      log.warn({ code: 'dev_auto_login_ignored', reason: found.reason }, 'DEV_AUTO_LOGIN ignored');
      return;
    }
    this.userId = found.userId;
    log.warn(
      { code: 'dev_auto_login_on', userId: found.userId },
      `DEV AUTO-LOGIN IS ON: anyone who opens ${TRUSTED_ORIGIN} on this Mac is signed in as user ${found.userId} ` +
        'with no password and no MFA. Remove DEV_AUTO_LOGIN from .env and restart the API to turn it off.',
    );
  }

  /**
   * GET and POST /api/v1/auth/dev-auto-login. Reached before the auth catch-all's MFA gate, so a
   * request with no session or with one that hasn't passed MFA gets here. A session already in
   * the request is left alone: POST makes a new one and the old one ends at its own time.
   */
  async handle(
    request: FastifyRequest,
    reply: FastifyReply,
    auth: AuthService,
    headers: Headers,
  ): Promise<FastifyReply> {
    if (request.method === 'GET') return reply.code(200).send({ on: this.on });

    if (!this.on) {
      sendError(request, reply, 404, 'not_found', 'Not found.');
      return reply;
    }
    if (!sameSiteRequest(request)) {
      sendError(request, reply, 403, 'forbidden', 'The request was refused.');
      return reply;
    }
    try {
      return await this.signIn(request, reply, auth, headers);
    } catch (err) {
      // Our one error format; the log line holds the error's type and code only (D163, D164). No
      // cookie leaves without its audit entry.
      request.log.error({ code: 'dev_auto_login_failed', ...errorKind(err) }, 'dev auto-login failed');
      sendError(
        request,
        reply,
        500,
        'internal_error',
        'Something went wrong. Quote the reference ID if you report it.',
      );
      return reply;
    }
  }

  private async signIn(
    request: FastifyRequest,
    reply: FastifyReply,
    auth: AuthService,
    headers: Headers,
  ): Promise<FastifyReply> {
    const found = await this.checkAccount(auth);
    if (!found.ok || found.userId !== this.userId) {
      const reason = found.ok ? 'account_changed' : found.reason;
      request.log.warn({ code: 'dev_auto_login_unavailable', reason }, 'dev auto-login refused');
      sendError(request, reply, 403, 'dev_auto_login_unavailable', 'Dev auto-login is unavailable.');
      return reply;
    }
    const call = (auth.auth.api as unknown as Record<string, DevSessionCall | undefined>)[DEV_SESSION_ENDPOINT_KEY];
    if (!call) {
      request.log.warn({ code: 'dev_auto_login_unavailable', reason: 'no_endpoint' }, 'dev auto-login refused');
      sendError(request, reply, 403, 'dev_auto_login_unavailable', 'Dev auto-login is unavailable.');
      return reply;
    }
    const made = await call({ headers, body: { activeOrganizationId: found.orgId }, returnHeaders: true });
    await auth.auditUser(found.userId, 'auth.sign_in', { method: 'dev_auto_login' });
    const cookies = made.headers?.getSetCookie() ?? [];
    if (cookies.length) void reply.header('set-cookie', cookies);
    return reply.code(200).send({ ok: true });
  }
}

/** Origin exactly ours, a JSON body, and no cross-site fetch: nothing another website can send. */
function sameSiteRequest(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (origin !== TRUSTED_ORIGIN) return false;
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string') return false;
  if (contentType.split(';')[0]!.trim().toLowerCase() !== 'application/json') return false;
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite !== undefined && fetchSite !== 'same-origin') return false;
  return true;
}
