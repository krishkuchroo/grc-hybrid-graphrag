// Sign-in with Better Auth inside the API (D10, D49, D54): email and password, the organization
// plugin and the 2FA plugin (TOTP plus backup codes), stored in Postgres through Drizzle as the
// restricted grc_app account (D57).
//
// The D54 rules kept here:
// - passwords of at least 12 characters, hashed by Better Auth (scrypt, salted);
// - a session ends 12 h after sign-in at most (Better Auth's own expiry, never extended), and
//   after 30 min without a request (checked and recorded by `resolveSession` on every request);
// - `session.mfa_verified` is set only on sessions made by the two-factor verify routes, so a
//   session that never checked a second factor stays limited (SessionGuard).
// Every time check reads the JavaScript clock.
import { drizzleAdapter } from '@better-auth/drizzle-adapter';
import { betterAuth } from 'better-auth';
import { hashPassword as betterAuthHash } from 'better-auth/crypto';
import { organization, twoFactor } from 'better-auth/plugins';
import { eq, sql } from 'drizzle-orm';
import type { Logger } from 'pino';
import { AuditService } from '../audit/audit.service.js';
import type { Db } from '../db/client.js';
import { LABELS, ROLES, type Label, type Role } from '../db/org-context.js';
import * as authSchema from './schema.js';

export const AUTH_BASE_PATH = '/api/v1/auth';
export const TRUSTED_ORIGIN = 'https://grc.localhost';
export const MIN_PASSWORD_LENGTH = 12;
export const SESSION_IDLE_MS = 30 * 60_000;
export const SESSION_MAX_MS = 12 * 60 * 60_000;

// The routes whose new session has passed the second factor.
const MFA_VERIFY_PATHS = new Set(['/two-factor/verify-totp', '/two-factor/verify-backup-code']);

/** The password hash Better Auth is set up with (used to seed users). */
export function hashPassword(plain: string): Promise<string> {
  return betterAuthHash(plain);
}

export function createAuth(db: Db, log: Logger | undefined, env: NodeJS.ProcessEnv = process.env) {
  const secret = env.BETTER_AUTH_SECRET;
  if (!secret) throw new Error('BETTER_AUTH_SECRET is not set');
  const baseURL = env.BETTER_AUTH_URL || TRUSTED_ORIGIN;
  return betterAuth({
    appName: 'GRC',
    baseURL,
    basePath: AUTH_BASE_PATH,
    secret,
    trustedOrigins: [TRUSTED_ORIGIN],
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    emailAndPassword: {
      enabled: true,
      minPasswordLength: MIN_PASSWORD_LENGTH,
      // Accounts are made by an org Admin, never by signing up (fail safe).
      disableSignUp: true,
    },
    session: {
      expiresIn: SESSION_MAX_MS / 1000,
      disableSessionRefresh: true,
      additionalFields: {
        mfaVerified: { type: 'boolean', required: false, defaultValue: false, input: false },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session, ctx) => ({
            data: { ...session, mfaVerified: MFA_VERIFY_PATHS.has(ctx?.path ?? '') },
          }),
        },
      },
    },
    plugins: [organization(), twoFactor({ issuer: 'GRC' })],
    // D64's limits are ours, counted per person (src/common/rate-limit.ts).
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    logger: {
      level: 'warn',
      // Only the message goes to pino: the extra arguments can hold request data.
      log: (level, message) => {
        log?.[level]({ context: 'BetterAuth' }, message);
      },
    },
  });
}

export type Auth = ReturnType<typeof createAuth>;

export interface Membership {
  orgId: string;
  role: Role;
  clearance: Label;
}

export interface ResolvedSession {
  sessionId: string;
  userId: string;
  user: { id: string; email: string; name: string; twoFactorEnabled: boolean };
  mfaVerified: boolean;
  activeOrganizationId: string | null;
}

export type SignInEvent =
  | 'auth.sign_in'
  | 'auth.password_verified'
  | 'auth.sign_in_failed'
  | 'auth.locked'
  | 'auth.sign_out'
  | 'auth.mfa_enrolled';

/** Better Auth plus what the API needs around it: session checks, memberships and sign-in audit. */
export class AuthService {
  private instance: Auth | undefined;
  private log: Logger | undefined;

  constructor(
    readonly db: Db,
    private readonly audit: AuditService,
  ) {}

  useLogger(log: Logger): void {
    this.log = log;
  }

  /** Built on first use, so the worker program never needs the auth secret. */
  get auth(): Auth {
    this.instance ??= createAuth(this.db, this.log);
    return this.instance;
  }

  /**
   * The request's session, or null. Ends a session that has been idle for 30 min or is 12 h old,
   * and records this request as activity on a live one.
   */
  async resolveSession(headers: Headers): Promise<ResolvedSession | null> {
    if (!headers.get('cookie')) return null;
    const found = await this.auth.api.getSession({ headers });
    if (!found) return null;
    const s = found.session as typeof found.session & { mfaVerified?: boolean; activeOrganizationId?: string | null };
    const now = Date.now();
    const table = authSchema.session;
    if (
      now - new Date(s.createdAt).getTime() >= SESSION_MAX_MS ||
      now - new Date(s.updatedAt).getTime() >= SESSION_IDLE_MS
    ) {
      await this.db.delete(table).where(eq(table.id, s.id));
      return null;
    }
    await this.db
      .update(table)
      .set({ updatedAt: new Date(now) })
      .where(eq(table.id, s.id));
    const u = found.user as typeof found.user & { twoFactorEnabled?: boolean | null };
    return {
      sessionId: s.id,
      userId: u.id,
      user: { id: u.id, email: u.email, name: u.name, twoFactorEnabled: u.twoFactorEnabled === true },
      mfaVerified: s.mfaVerified === true,
      activeOrganizationId: s.activeOrganizationId ?? null,
    };
  }

  /** The user's memberships, oldest first (read past the org wall for this one user only). */
  async memberships(userId: string): Promise<Membership[]> {
    const res = await this.db.execute<{ org_id: string; role: string; clearance: string }>(
      sql`SELECT org_id, role, clearance FROM app_user_memberships(${userId})`,
    );
    return res.rows
      .filter(
        (r) => (ROLES as readonly string[]).includes(r.role) && (LABELS as readonly string[]).includes(r.clearance),
      )
      .map((r) => ({ orgId: r.org_id, role: r.role as Role, clearance: r.clearance as Label }));
  }

  /**
   * The org a request runs in: the session's active org if the user is a member of it, else
   * (no active org) the user's oldest membership. Null when there is none: never another org.
   */
  async membershipFor(session: ResolvedSession): Promise<Membership | null> {
    const list = await this.memberships(session.userId);
    if (session.activeOrganizationId) return list.find((m) => m.orgId === session.activeOrganizationId) ?? null;
    return list[0] ?? null;
  }

  async userIdByEmail(email: string): Promise<string | null> {
    if (!email) return null;
    const ctx = await this.auth.$context;
    const found = await ctx.internalAdapter.findUserByEmail(email.toLowerCase());
    return found?.user.id ?? null;
  }

  /** The user waiting for a second factor, from the two_factor cookie's challenge (audit only). */
  async userIdFromTwoFactorCookie(cookieHeader: string | undefined): Promise<string | null> {
    if (!cookieHeader) return null;
    for (const part of cookieHeader.split(';')) {
      const eqAt = part.indexOf('=');
      if (eqAt < 0) continue;
      const name = part.slice(0, eqAt).trim();
      if (name !== 'better-auth.two_factor' && name !== '__Secure-better-auth.two_factor') continue;
      let value = part.slice(eqAt + 1).trim();
      try {
        value = decodeURIComponent(value);
      } catch {
        return null;
      }
      const dot = value.lastIndexOf('.');
      const identifier = dot > 0 ? value.slice(0, dot) : value;
      const ctx = await this.auth.$context;
      const found = await ctx.internalAdapter.findVerificationValue(identifier);
      if (!found || new Date(found.expiresAt).getTime() <= Date.now()) return null;
      return typeof found.value === 'string' ? found.value : null;
    }
    return null;
  }

  /**
   * Writes a sign-in event into the audit chain of each org the user belongs to. Returns false
   * when there is no org chain to write to (unknown email, or no membership).
   */
  async auditUser(userId: string | null, action: SignInEvent, meta: Record<string, unknown> = {}): Promise<boolean> {
    if (!userId) return false;
    const orgs = await this.memberships(userId);
    for (const m of orgs) {
      await this.audit.append({
        orgId: m.orgId,
        actorType: 'user',
        actorId: userId,
        action,
        targetType: 'user',
        targetId: userId,
        meta,
      });
    }
    return orgs.length > 0;
  }
}
