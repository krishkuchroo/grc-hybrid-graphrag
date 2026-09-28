// M0-010 criterion 1 (D54).
// 1. Passwords under 12 characters are refused. Passwords are stored hashed, never in plain text.
// A password is set through Better Auth's change-password route, by a user signed in with MFA.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AUTH,
  Jar,
  allAuditText,
  call,
  mfaUser,
  q,
  seedOrg,
  setUpAuth,
  show,
  signInFull,
  signInPassword,
  tearDownAuth,
  wantsSecondFactor,
  type AuthEnv,
  type Org,
} from './helpers.js';

let env: AuthEnv | undefined;
let org: Org;

beforeAll(async () => {
  env = await setUpAuth();
  org = await seedOrg(env.k, 'Password Org');
}, 180_000);

afterAll(async () => {
  await tearDownAuth(env);
});

function e(): AuthEnv {
  if (!env) throw new Error('the API app did not start (see beforeAll)');
  return env;
}

async function storedHash(userId: string): Promise<string> {
  const found = await q<{ password: string | null }>(
    e().k,
    `SELECT password FROM "account" WHERE user_id = $1 AND provider_id = 'credential'`,
    [userId],
  );
  expect(found.length).toBe(1);
  return found[0]!.password ?? '';
}

describe('criterion 1: at least 12 characters', () => {
  it.each([
    ['11 characters', 'Abcdefgh-1!'],
    ['1 character', 'x'],
    ['empty', ''],
  ])('refuses a new password of %s, and the old one keeps working', async (_name, newPassword) => {
    const { user, jar, mfa } = await mfaUser(e().k, e().app, org);
    const before = await storedHash(user.id);
    const res = await call(e().app, jar, {
      method: 'POST',
      url: `${AUTH}/change-password`,
      payload: { currentPassword: user.password, newPassword },
    });
    expect(res.statusCode, show(res)).toBeGreaterThanOrEqual(400);
    expect(res.statusCode, show(res)).toBeLessThan(500);
    expect(await storedHash(user.id)).toBe(before);
    await signInFull(e().app, user, mfa);
  });

  it('accepts exactly 12 characters, and the new password then signs in', async () => {
    const { user, jar, mfa } = await mfaUser(e().k, e().app, org);
    const newPassword = 'Abcdefgh-12!';
    expect(newPassword.length).toBe(12);
    const res = await call(e().app, jar, {
      method: 'POST',
      url: `${AUTH}/change-password`,
      payload: { currentPassword: user.password, newPassword },
    });
    expect(res.statusCode, show(res)).toBe(200);

    const old = await signInPassword(e().app, new Jar(), user.email, user.password);
    expect(wantsSecondFactor(old), `the old password must stop working: ${show(old)}`).toBe(false);
    await signInFull(e().app, { ...user, password: newPassword }, mfa);
  });
});

describe('criterion 1: stored hashed, never in plain text', () => {
  it('the stored value after a change is a hash, not the password', async () => {
    const { user, jar } = await mfaUser(e().k, e().app, org);
    const newPassword = 'Plain-text-canary-4417';
    const res = await call(e().app, jar, {
      method: 'POST',
      url: `${AUTH}/change-password`,
      payload: { currentPassword: user.password, newPassword },
    });
    expect(res.statusCode, show(res)).toBe(200);
    const stored = await storedHash(user.id);
    expect(stored.length).toBeGreaterThanOrEqual(32);
    expect(stored).not.toBe(newPassword);
    expect(stored).not.toContain(newPassword);
    expect(stored).not.toContain(Buffer.from(newPassword).toString('base64'));
    expect(stored).not.toContain(Buffer.from(newPassword).toString('hex'));
  });

  it('the same password gives two different stored values (salted)', async () => {
    const shared = 'Same-password-for-both-9';
    const a = await mfaUser(e().k, e().app, org, { password: shared });
    const b = await mfaUser(e().k, e().app, org, { password: shared });
    for (const u of [a, b]) {
      const res = await call(e().app, u.jar, {
        method: 'POST',
        url: `${AUTH}/change-password`,
        payload: { currentPassword: shared, newPassword: 'Changed-same-for-both-9' },
      });
      expect(res.statusCode, show(res)).toBe(200);
    }
    expect(await storedHash(a.user.id)).not.toBe(await storedHash(b.user.id));
  });

  it('no password appears anywhere in the database rows, the audit trail or the logs', async () => {
    const { user } = await mfaUser(e().k, e().app, org, { password: 'Leak-canary-password-7731' });
    await signInPassword(e().app, new Jar(), user.email, 'Leak-canary-wrong-pass-7731');
    const dump = await q<{ t: string }>(
      e().k,
      `SELECT coalesce(string_agg(x, '\n'), '') AS t FROM (
         SELECT row_to_json(u)::text AS x FROM "user" u
         UNION ALL SELECT row_to_json(a)::text FROM "account" a
         UNION ALL SELECT row_to_json(s)::text FROM "session" s
         UNION ALL SELECT row_to_json(v)::text FROM "verification" v
       ) rows`,
    );
    const everything = [dump[0]!.t, await allAuditText(e().k), e().logs.lines.join('\n')].join('\n');
    expect(everything).not.toContain('Leak-canary-password-7731');
    expect(everything).not.toContain('Leak-canary-wrong-pass-7731');
  });
});
