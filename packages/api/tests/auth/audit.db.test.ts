// M0-010 criterion 5 (D54, D56), with a fake clock for the lock.
// 5. Every sign-in attempt, good or bad, writes one audit event. A failed attempt for an unknown
//    email is also logged, and the response doesn't reveal whether the email exists.
// Events (brief "Interfaces", through AuditService.append from M0-012): auth.sign_in,
// auth.sign_in_failed, auth.locked, auth.sign_out, auth.mfa_enrolled. They go to the org the user
// is a member of, with actor type `user` and the user's ID.
// A complete sign-in is the password plus the second factor: it is one attempt, so it writes one
// `auth.sign_in` (not one per step). A right password with a wrong code is one failed attempt.
// D162 (Q41 answer a) adds a sixth event name: when the password is right, `auth.password_verified`
// is written at once, before the second factor. `auth.sign_in` follows only when the second factor
// succeeds. A wrong password still writes `auth.sign_in_failed`. A right password whose second
// factor is never finished is what a stolen password looks like, so it must show in the trail.
// An unknown email belongs to no org, so it has no org audit chain to go to: it must be logged in
// the API's own log (pino) as `auth.sign_in_failed`, and write nothing into any org's chain.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AUTH,
  MINUTE,
  Jar,
  actions,
  advance,
  allAuditText,
  auditDuring,
  call,
  enrol,
  errorCode,
  freezeClock,
  json,
  mfaUser,
  realClock,
  seedOrg,
  seedUser,
  setUpAuth,
  show,
  signInFull,
  signInPassword,
  tearDownAuth,
  totpNow,
  wantsSecondFactor,
  wrongCode,
  type AuditRow,
  type AuthEnv,
  type Org,
} from './helpers.js';

let env: AuthEnv | undefined;
let org: Org;
let otherOrg: Org;

beforeAll(async () => {
  env = await setUpAuth();
  org = await seedOrg(env.k, 'Audit Org');
  otherOrg = await seedOrg(env.k, 'Bystander Org');
}, 180_000);

afterAll(async () => {
  realClock();
  await tearDownAuth(env);
});

beforeEach(() => freezeClock());
afterEach(() => realClock());

function e(): AuthEnv {
  if (!env) throw new Error('the API app did not start (see beforeAll)');
  return env;
}

const SIGN_IN_ACTIONS = ['auth.sign_in', 'auth.sign_in_failed'];

function signInEvents(list: AuditRow[]): AuditRow[] {
  return list.filter((ev) => SIGN_IN_ACTIONS.includes(ev.action));
}

function expectActor(list: AuditRow[], userId: string): void {
  for (const ev of list) {
    expect(ev.actor_type, ev.text).toBe('user');
    expect(ev.actor_id, ev.text).toBe(userId);
  }
}

describe('criterion 5: one audit event per sign-in attempt', () => {
  it('a full sign-in (password + TOTP) writes exactly one auth.sign_in', async () => {
    const user = await seedUser(e().k, org);
    const { mfa } = await enrol(e().app, user);
    advance(MINUTE);
    const added = await auditDuring(e().k, org.id, () => signInFull(e().app, user, mfa));
    expect(actions(signInEvents(added))).toEqual(['auth.sign_in']);
    expectActor(added, user.id);
  });

  it('a wrong password writes exactly one auth.sign_in_failed', async () => {
    const user = await seedUser(e().k, org);
    await enrol(e().app, user);
    const added = await auditDuring(e().k, org.id, () =>
      signInPassword(e().app, new Jar(), user.email, 'Wrong-password-for-audit-1'),
    );
    expect(actions(added)).toEqual(['auth.sign_in_failed']);
    expectActor(added, user.id);
  });

  it('a wrong password with the email in another case is audited for the same user', async () => {
    const user = await seedUser(e().k, org);
    await enrol(e().app, user);
    const added = await auditDuring(e().k, org.id, () =>
      signInPassword(e().app, new Jar(), user.email.toUpperCase(), 'Wrong-password-for-audit-2'),
    );
    expect(actions(added)).toEqual(['auth.sign_in_failed']);
    expectActor(added, user.id);
  });

  it('the right password with a wrong TOTP code writes exactly one auth.sign_in_failed and no auth.sign_in', async () => {
    const user = await seedUser(e().k, org);
    const { mfa } = await enrol(e().app, user);
    advance(MINUTE);
    const added = await auditDuring(e().k, org.id, async () => {
      const jar = new Jar();
      expect(wantsSecondFactor(await signInPassword(e().app, jar, user.email, user.password))).toBe(true);
      const res = await call(e().app, jar, {
        method: 'POST',
        url: `${AUTH}/two-factor/verify-totp`,
        payload: { code: wrongCode(mfa.totp) },
      });
      expect(res.statusCode, show(res)).toBeGreaterThanOrEqual(400);
    });
    expect(actions(signInEvents(added))).toEqual(['auth.sign_in_failed']);
    expectActor(added, user.id);
  });

  it('a sign-in without MFA enrolled yet (password only) writes exactly one auth.sign_in', async () => {
    const user = await seedUser(e().k, org);
    const added = await auditDuring(e().k, org.id, async () => {
      const res = await signInPassword(e().app, new Jar(), user.email, user.password);
      expect(res.statusCode, show(res)).toBe(200);
    });
    expect(actions(signInEvents(added))).toEqual(['auth.sign_in']);
    expectActor(added, user.id);
  });

  it('the 5th wrong password writes auth.sign_in_failed plus one auth.locked; each attempt while locked writes one auth.sign_in_failed', async () => {
    const user = await seedUser(e().k, org);
    await enrol(e().app, user);
    const firstFour = await auditDuring(e().k, org.id, async () => {
      for (let i = 0; i < 4; i++) await signInPassword(e().app, new Jar(), user.email, `Wrong-password-${i}-xx`);
    });
    expect(actions(firstFour)).toEqual(Array(4).fill('auth.sign_in_failed'));

    const fifth = await auditDuring(e().k, org.id, () =>
      signInPassword(e().app, new Jar(), user.email, 'Wrong-password-5-xx'),
    );
    expect(actions(signInEvents(fifth))).toEqual(['auth.sign_in_failed']);
    expect(actions(fifth).filter((a) => a === 'auth.locked')).toEqual(['auth.locked']);
    expectActor(fifth, user.id);

    const whileLocked = await auditDuring(e().k, org.id, async () => {
      await signInPassword(e().app, new Jar(), user.email, user.password);
      await signInPassword(e().app, new Jar(), user.email, 'Wrong-password-6-xx');
    });
    expect(actions(signInEvents(whileLocked))).toEqual(['auth.sign_in_failed', 'auth.sign_in_failed']);
    expect(actions(whileLocked)).not.toContain('auth.sign_in');
  });

  it('sign-out writes one auth.sign_out', async () => {
    const { user, jar } = await mfaUser(e().k, e().app, org);
    const added = await auditDuring(e().k, org.id, async () => {
      const res = await call(e().app, jar, { method: 'POST', url: `${AUTH}/sign-out`, payload: {} });
      expect(res.statusCode, show(res)).toBe(200);
    });
    expect(actions(added)).toEqual(['auth.sign_out']);
    expectActor(added, user.id);
  });

  it('finishing MFA enrolment writes one auth.mfa_enrolled', async () => {
    const user = await seedUser(e().k, org);
    const added = await auditDuring(e().k, org.id, () => enrol(e().app, user));
    expect(actions(added).filter((a) => a === 'auth.mfa_enrolled')).toEqual(['auth.mfa_enrolled']);
    expectActor(added, user.id);
  });

  it("a user's sign-in events go to their own org only", async () => {
    const user = await seedUser(e().k, org);
    const { mfa } = await enrol(e().app, user);
    advance(MINUTE);
    const inOther = await auditDuring(e().k, otherOrg.id, async () => {
      await signInPassword(e().app, new Jar(), user.email, 'Wrong-password-other-org');
      await signInFull(e().app, user, mfa);
    });
    expect(inOther).toEqual([]);
  });

  it('no audit event carries the password or the TOTP code', async () => {
    const user = await seedUser(e().k, org, { password: 'Audit-canary-password-5521' });
    const { mfa } = await enrol(e().app, user);
    advance(MINUTE);
    const code = totpNow(mfa.totp);
    await signInPassword(e().app, new Jar(), user.email, 'Audit-canary-wrong-5521');
    await signInFull(e().app, user, mfa);
    const text = await allAuditText(e().k);
    expect(text).not.toContain('Audit-canary-password-5521');
    expect(text).not.toContain('Audit-canary-wrong-5521');
    expect(text).not.toContain(`"${code}"`);
  });
});

describe('D162: a right password is audited at once, before the second factor', () => {
  it('right password and no second factor: exactly one auth.password_verified and no auth.sign_in', async () => {
    const user = await seedUser(e().k, org);
    await enrol(e().app, user);
    advance(MINUTE);
    const added = await auditDuring(e().k, org.id, async () => {
      const res = await signInPassword(e().app, new Jar(), user.email, user.password);
      expect(wantsSecondFactor(res), show(res)).toBe(true);
    });
    expect(actions(added)).toEqual(['auth.password_verified']);
    expectActor(added, user.id);
  });

  it('right password then the right TOTP: auth.password_verified, then auth.sign_in', async () => {
    const user = await seedUser(e().k, org);
    const { mfa } = await enrol(e().app, user);
    advance(MINUTE);
    const added = await auditDuring(e().k, org.id, () => signInFull(e().app, user, mfa));
    expect(actions(added)).toEqual(['auth.password_verified', 'auth.sign_in']);
    expectActor(added, user.id);
  });

  it('right password then a wrong TOTP: auth.password_verified, then auth.sign_in_failed', async () => {
    const user = await seedUser(e().k, org);
    const { mfa } = await enrol(e().app, user);
    advance(MINUTE);
    const added = await auditDuring(e().k, org.id, async () => {
      const jar = new Jar();
      expect(wantsSecondFactor(await signInPassword(e().app, jar, user.email, user.password))).toBe(true);
      const res = await call(e().app, jar, {
        method: 'POST',
        url: `${AUTH}/two-factor/verify-totp`,
        payload: { code: wrongCode(mfa.totp) },
      });
      expect(res.statusCode, show(res)).toBeGreaterThanOrEqual(400);
    });
    expect(actions(added)).toEqual(['auth.password_verified', 'auth.sign_in_failed']);
    expectActor(added, user.id);
  });

  it('a wrong password writes only auth.sign_in_failed; the right one after it writes auth.password_verified', async () => {
    const user = await seedUser(e().k, org);
    await enrol(e().app, user);
    const added = await auditDuring(e().k, org.id, async () => {
      await signInPassword(e().app, new Jar(), user.email, 'Wrong-password-for-d162-1');
      // Its right password, sent once more, is what proves the event name is in use.
      await signInPassword(e().app, new Jar(), user.email, user.password);
    });
    expect(actions(added)).toEqual(['auth.sign_in_failed', 'auth.password_verified']);
  });

  it("auth.password_verified goes to the user's own org, carrying the user and the org", async () => {
    const user = await seedUser(e().k, org);
    await enrol(e().app, user);
    advance(MINUTE);
    let inOther: AuditRow[] = [];
    const inOrg = await auditDuring(e().k, org.id, async () => {
      inOther = await auditDuring(e().k, otherOrg.id, () =>
        signInPassword(e().app, new Jar(), user.email, user.password),
      );
    });
    expect(inOther).toEqual([]);
    const verified = inOrg.filter((ev) => ev.action === 'auth.password_verified');
    expect(verified.length, JSON.stringify(actions(inOrg))).toBe(1);
    const row = JSON.parse(verified[0]!.text) as Record<string, unknown>;
    expect(row.org_id).toBe(org.id);
    expect(row.actor_type).toBe('user');
    expect(row.actor_id).toBe(user.id);
  });

  it('auth.password_verified never carries the password or the TOTP code', async () => {
    const user = await seedUser(e().k, org, { password: 'Verified-canary-password-7731' });
    const { mfa } = await enrol(e().app, user);
    advance(MINUTE);
    const code = totpNow(mfa.totp);
    const added = await auditDuring(e().k, org.id, () => signInFull(e().app, user, mfa));
    const verified = added.filter((ev) => ev.action === 'auth.password_verified');
    expect(verified.length, JSON.stringify(actions(added))).toBe(1);
    for (const ev of added) {
      expect(ev.text).not.toContain('Verified-canary-password-7731');
      expect(ev.text).not.toContain(`"${code}"`);
    }
    const text = await allAuditText(e().k);
    expect(text).not.toContain('Verified-canary-password-7731');
  });
});

describe('criterion 5: an unknown email', () => {
  it('is logged as auth.sign_in_failed, and writes nothing into any org chain', async () => {
    const email = `nobody.${Date.now().toString(36)}@x.test`;
    const before = e().logs.lines.length;
    let inOther: AuditRow[] = [];
    const inOrg = await auditDuring(e().k, org.id, async () => {
      inOther = await auditDuring(e().k, otherOrg.id, () =>
        signInPassword(e().app, new Jar(), email, 'Some-password-123'),
      );
    });
    expect(inOrg).toEqual([]);
    expect(inOther).toEqual([]);
    const lines = e()
      .logs.lines.slice(before)
      .filter((l) => l.includes('auth.sign_in_failed'));
    expect(lines.length, 'one log line for the failed attempt').toBe(1);
    expect(lines[0]).not.toContain('Some-password-123');
  });

  it('gets the same answer as a wrong password for a real email', async () => {
    const user = await seedUser(e().k, org);
    await enrol(e().app, user);
    const known = await signInPassword(e().app, new Jar(), user.email, 'Wrong-password-known-1');
    const unknown = await signInPassword(
      e().app,
      new Jar(),
      `ghost.${Date.now().toString(36)}@x.test`,
      'Wrong-password-known-1',
    );
    expect(unknown.statusCode, show(unknown)).toBe(known.statusCode);
    expect(errorCode(unknown)).toBe(errorCode(known));
    expect(json(unknown).message).toEqual(json(known).message);
    expect(known.headers['set-cookie']).toBeUndefined();
    expect(unknown.headers['set-cookie']).toBeUndefined();
  });

  it('does not reveal itself through the lock either: the 6th try looks the same for a real and an unknown email', async () => {
    const user = await seedUser(e().k, org);
    await enrol(e().app, user);
    const ghost = `ghost6.${Date.now().toString(36)}@x.test`;
    for (let i = 0; i < 5; i++) {
      await signInPassword(e().app, new Jar(), user.email, `Wrong-password-${i}-lock`);
      await signInPassword(e().app, new Jar(), ghost, `Wrong-password-${i}-lock`);
    }
    const known = await signInPassword(e().app, new Jar(), user.email, 'Wrong-password-6-lock');
    const unknown = await signInPassword(e().app, new Jar(), ghost, 'Wrong-password-6-lock');
    expect(unknown.statusCode, `known: ${show(known)} / unknown: ${show(unknown)}`).toBe(known.statusCode);
    expect(errorCode(unknown)).toBe(errorCode(known));
    expect(json(unknown).message).toEqual(json(known).message);
  });
});
