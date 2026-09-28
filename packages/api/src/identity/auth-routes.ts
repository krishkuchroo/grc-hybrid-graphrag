// Better Auth on the API's Fastify instance (D49, D54, D56, D64).
//
// `registerSessionHook` reads the request's session before anything else (an `onRequest` hook), so
// the rate limit counts a signed-in person by their user ID, not their address (D64), and the
// SessionGuard finds it on `request.authSession`.
//
// `registerAuthRoutes` mounts Better Auth at /api/v1/auth/* with our rules around it:
// - only the routes we use are open; the rest answer 404, so Better Auth's tables are never
//   listed through the API (M0-009 security review). Signing up is off: an Admin adds people;
// - a session without MFA may only finish MFA set-up or sign out (403 `mfa_required`);
// - MFA can't be turned off, and "trust this device" is ignored (MFA for everyone, D54);
// - the 5-failure lock (lockout.ts), keyed on the account;
// - one audit event per sign-in attempt, in the user's org (D56), plus `auth.password_verified`
//   as soon as a password is right (D162). An unknown email has no org chain, so it goes to the
//   API's pino log instead. Passwords and codes are never recorded.
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { CODES, sendError } from '../common/errors.js';
import { AUTH_BASE_PATH, type AuthService, type ResolvedSession } from './auth.js';
import { lockKey, SignInLockout } from './lockout.js';
import type { AuthedRequest } from './session.guard.js';

const SIGN_IN = '/sign-in/email';
const SIGN_OUT = '/sign-out';
const VERIFY_TOTP = '/two-factor/verify-totp';
const VERIFY_BACKUP = '/two-factor/verify-backup-code';

// What a session that hasn't passed MFA may still do.
const ALLOWED_WITHOUT_MFA = new Set([SIGN_IN, SIGN_OUT, '/two-factor/enable', VERIFY_TOTP, VERIFY_BACKUP]);

// Better Auth routes the API offers at all.
const OPEN_ROUTES = new Set([
  ...ALLOWED_WITHOUT_MFA,
  '/two-factor/generate-backup-codes',
  '/change-password',
  '/organization/set-active',
]);

/** The routes registered straight on Fastify (not through Nest), with full paths. The D175
 * security matrix test compares them with packages/shared/src/access/security-matrix.ts. */
export const DIRECT_ROUTES: readonly { method: 'GET' | 'POST'; path: string }[] = [
  { method: 'GET', path: `${AUTH_BASE_PATH}/*` },
  { method: 'POST', path: `${AUTH_BASE_PATH}/*` },
];

type Req = FastifyRequest & AuthedRequest & { user?: { id: string } };

function webHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (value === undefined || name === 'content-length') continue;
    if (Array.isArray(value)) for (const v of value) headers.append(name, v);
    else headers.set(name, String(value));
  }
  return headers;
}

export function registerSessionHook(fastify: FastifyInstance, auth: AuthService): void {
  fastify.addHook('onRequest', async (request) => {
    const req = request as Req;
    req.authSession = null;
    try {
      const session = await auth.resolveSession(webHeaders(request));
      req.authSession = session;
      if (session) req.user = { id: session.userId };
    } catch (err) {
      request.log.error({ err }, 'session lookup failed');
    }
  });
}

interface Forwarded {
  status: number;
  headers: Headers;
  text: string;
  json: Record<string, unknown>;
}

export function registerAuthRoutes(fastify: FastifyInstance, auth: AuthService, log: Logger): void {
  auth.useLogger(log);
  const lockout = new SignInLockout();

  async function forward(request: FastifyRequest, body?: unknown): Promise<Forwarded> {
    const base = auth.auth.options.baseURL ?? 'https://grc.localhost';
    const hasBody = request.method !== 'GET' && request.method !== 'HEAD';
    const headers = webHeaders(request);
    if (hasBody) headers.set('content-type', 'application/json');
    const res = await auth.auth.handler(
      new Request(new URL(request.url, base), {
        method: request.method,
        headers,
        ...(hasBody ? { body: JSON.stringify(body ?? request.body ?? {}) } : {}),
      }),
    );
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      const parsed: unknown = text ? JSON.parse(text) : {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>;
    } catch {
      // not JSON
    }
    return { status: res.status, headers: res.headers, text, json };
  }

  // Better Auth's answer goes back as it is, except errors: those leave in our one format with a
  // reference ID and a log line (D47). Its cookies are kept either way.
  function send(request: FastifyRequest, reply: FastifyReply, res: Forwarded): FastifyReply {
    const cookies = res.headers.getSetCookie();
    if (res.status >= 400) {
      if (cookies.length) void reply.header('set-cookie', cookies);
      const code = typeof res.json.code === 'string' && res.json.code ? res.json.code.toLowerCase() : undefined;
      const message = typeof res.json.message === 'string' && res.json.message ? res.json.message : undefined;
      sendError(
        request,
        reply,
        res.status,
        code ?? CODES[res.status] ?? 'error',
        message ?? 'The request was refused.',
      );
      return reply;
    }
    reply.code(res.status);
    res.headers.forEach((value, name) => {
      if (name === 'set-cookie' || name === 'content-length') return;
      void reply.header(name, value);
    });
    if (cookies.length) void reply.header('set-cookie', cookies);
    return reply.send(res.text);
  }

  // A failed attempt: into the user's org chain, or into the log when there is none.
  async function failed(request: FastifyRequest, userId: string | null, meta: Record<string, unknown>): Promise<void> {
    if (!(await auth.auditUser(userId, 'auth.sign_in_failed', meta))) {
      request.log.warn({ event: 'auth.sign_in_failed', ...meta }, 'sign-in failed');
    }
  }

  function bodyOf(request: FastifyRequest): Record<string, unknown> {
    const b = request.body;
    return b && typeof b === 'object' && !Array.isArray(b) ? { ...(b as Record<string, unknown>) } : {};
  }

  async function signIn(request: Req, reply: FastifyReply): Promise<FastifyReply> {
    const body = bodyOf(request);
    const key = lockKey(body.email);
    // The slot is taken before the password is checked, so guesses sent at once can't pass the lock.
    const lock = key ? lockout.begin(key) : ({ locked: false } as const);
    if (lock.locked) {
      await failed(request, await auth.userIdByEmail(key), { method: 'password', reason: 'locked' });
      const minutes = Math.ceil(lock.retryAfterSeconds / 60);
      sendError(request, reply, 429, 'account_locked', `Too many failed sign-ins. Try again in ${minutes} min.`, {
        'retry-after': String(lock.retryAfterSeconds),
      });
      return reply;
    }
    let res: Forwarded;
    try {
      res = await forward(request, body);
    } catch (err) {
      if (key) lockout.fail(key); // fail safe: an attempt that couldn't be checked still counts
      throw err;
    }
    if (res.status === 200) {
      if (key) lockout.succeed(key);
      // With MFA on, the attempt finishes at the second factor. The right password is audited at
      // once, so one whose second factor never comes still shows in the trail (D162).
      if (res.json.twoFactorRedirect === true) {
        await auth.auditUser(await auth.userIdByEmail(key), 'auth.password_verified', { method: 'password' });
      } else {
        const user = res.json.user as { id?: unknown } | undefined;
        await auth.auditUser(typeof user?.id === 'string' ? user.id : null, 'auth.sign_in', { method: 'password' });
      }
      return send(request, reply, res);
    }
    const userId = key ? await auth.userIdByEmail(key) : null;
    const lockedNow = key ? lockout.fail(key) : false;
    await failed(request, userId, { method: 'password', reason: 'wrong_password' });
    if (lockedNow) {
      if (!(await auth.auditUser(userId, 'auth.locked', { minutes: 15 }))) {
        request.log.warn({ event: 'auth.locked' }, 'sign-in locked');
      }
    }
    return send(request, reply, res);
  }

  async function verify(request: Req, reply: FastifyReply, path: string): Promise<FastifyReply> {
    const body = bodyOf(request);
    delete body.trustDevice; // MFA for everyone: no device skips it (D54)
    const method = path === VERIFY_TOTP ? 'totp' : 'backup_code';
    const session: ResolvedSession | null | undefined = request.authSession;
    if (session) {
      // Inside a session: finishing enrolment.
      const res = await forward(request, body);
      if (res.status === 200 && !session.user.twoFactorEnabled) {
        await auth.auditUser(session.userId, 'auth.mfa_enrolled', { method });
      }
      return send(request, reply, res);
    }
    // The second step of a sign-in.
    const pending = await auth.userIdFromTwoFactorCookie(request.headers.cookie);
    const res = await forward(request, body);
    if (res.status === 200) {
      const user = res.json.user as { id?: unknown } | undefined;
      await auth.auditUser(typeof user?.id === 'string' ? user.id : pending, 'auth.sign_in', { method });
    } else {
      await failed(request, pending, { method, reason: 'wrong_code' });
    }
    return send(request, reply, res);
  }

  async function signOut(request: Req, reply: FastifyReply): Promise<FastifyReply> {
    const session = request.authSession;
    const res = await forward(request);
    if (res.status === 200 && session) await auth.auditUser(session.userId, 'auth.sign_out');
    return send(request, reply, res);
  }

  fastify.route({
    method: ['GET', 'POST'],
    url: `${AUTH_BASE_PATH}/*`,
    handler: async (request, reply) => {
      const req = request as Req;
      const path = new URL(request.url, 'http://x').pathname.slice(AUTH_BASE_PATH.length);
      const session = req.authSession;
      if (session && !session.mfaVerified && !ALLOWED_WITHOUT_MFA.has(path)) {
        sendError(request, reply, 403, 'mfa_required', 'Set up and check two-factor sign-in first.');
        return reply;
      }
      if (path === '/two-factor/disable') {
        sendError(request, reply, 403, 'forbidden', 'Two-factor sign-in is required for everyone.');
        return reply;
      }
      if (!OPEN_ROUTES.has(path)) {
        sendError(request, reply, 404, 'not_found', 'Not found.');
        return reply;
      }
      if (path === SIGN_IN) return signIn(req, reply);
      if (path === VERIFY_TOTP || path === VERIFY_BACKUP) return verify(req, reply, path);
      if (path === SIGN_OUT) return signOut(req, reply);
      return send(request, reply, await forward(request));
    },
  });
}
