// M0-010 criterion 4 (D54, D64), with a fake clock.
// 4. The 5th wrong password in a row locks the account for 15 min, and even the right password is
//    refused while locked. Email case doesn't matter (`Alice@x.test` and `alice@x.test` count as
//    one account).
// From M0-007's security review (D64): behind Caddy many people share one client address, so the
// lock keys on the account, not on the address. Wrong passwords from many addresses still lock the
// account, and a locked account doesn't lock out anyone else on the same address.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  MINUTE,
  PROBE,
  Jar,
  actions,
  advance,
  auditDuring,
  call,
  enrol,
  errorCode,
  freezeClock,
  realClock,
  seedOrg,
  seedUser,
  setUpAuth,
  show,
  signInFull,
  signInPassword,
  tearDownAuth,
  wantsSecondFactor,
  type AuthEnv,
  type Mfa,
  type Org,
  type User,
} from './helpers.js';

let env: AuthEnv | undefined;
let org: Org;

beforeAll(async () => {
  env = await setUpAuth();
  org = await seedOrg(env.k, 'Lockout Org');
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

async function enrolled(email?: string): Promise<{ user: User; mfa: Mfa }> {
  const user = await seedUser(e().k, org, email ? { email } : {});
  const { mfa } = await enrol(e().app, user);
  advance(MINUTE);
  return { user, mfa };
}

async function wrong(email: string, remoteAddress?: string): Promise<void> {
  const res = await signInPassword(e().app, new Jar(), email, 'Definitely-wrong-password-1', remoteAddress);
  expect(res.statusCode, `a wrong password must be refused: ${show(res)}`).toBeGreaterThanOrEqual(400);
  expect(wantsSecondFactor(res)).toBe(false);
}

// The right password is accepted when sign-in moves on to the second factor.
async function rightPasswordAccepted(user: User, remoteAddress?: string): Promise<boolean> {
  const res = await signInPassword(e().app, new Jar(), user.email, user.password, remoteAddress);
  if (wantsSecondFactor(res)) return true;
  expect(res.statusCode, `a refused sign-in must not look like success: ${show(res)}`).toBeGreaterThanOrEqual(400);
  return false;
}

describe('criterion 4: 5 wrong passwords in a row lock the account for 15 minutes', () => {
  it('4 wrong passwords do not lock', async () => {
    const { user } = await enrolled();
    for (let i = 0; i < 4; i++) await wrong(user.email);
    expect(await rightPasswordAccepted(user)).toBe(true);
  });

  it('the 5th wrong password locks: the right password is refused, and no session is made', async () => {
    const { user, mfa } = await enrolled();
    for (let i = 0; i < 5; i++) await wrong(user.email);
    const jar = new Jar();
    const res = await signInPassword(e().app, jar, user.email, user.password);
    expect(wantsSecondFactor(res), show(res)).toBe(false);
    expect(res.statusCode, show(res)).toBeGreaterThanOrEqual(400);
    const probe = await call(e().app, jar, { url: `${PROBE}/whoami` });
    expect(probe.statusCode).toBe(401);
    // Still locked at 14 min 59 s.
    advance(14 * MINUTE + 59_000);
    expect(await rightPasswordAccepted(user)).toBe(false);
    // Unlocked after 15 min: the full sign-in works again.
    advance(2_000);
    await signInFull(e().app, user, mfa);
  });

  it('"in a row": a successful sign-in resets the count', async () => {
    const { user, mfa } = await enrolled();
    for (let i = 0; i < 4; i++) await wrong(user.email);
    await signInFull(e().app, user, mfa);
    advance(MINUTE);
    for (let i = 0; i < 4; i++) await wrong(user.email);
    expect(await rightPasswordAccepted(user)).toBe(true);
  });

  it('email case does not matter: Alice@, ALICE@ and alice@ count as one account', async () => {
    const local = `alice.${Date.now().toString(36)}`;
    const { user } = await enrolled(`${local}@x.test`);
    const variants = [
      `${local[0]!.toUpperCase()}${local.slice(1)}@x.test`,
      `${local.toUpperCase()}@X.TEST`,
      `${local}@x.test`,
      `${local}@X.test`,
      `${local[0]!.toUpperCase()}${local.slice(1)}@x.test`,
    ];
    for (const email of variants) await wrong(email);
    expect(await rightPasswordAccepted(user)).toBe(false);
    expect(await rightPasswordAccepted({ ...user, email: variants[1]! })).toBe(false);
  });

  it('a mixed-case email signs in to the same account when not locked', async () => {
    const local = `bob.${Date.now().toString(36)}`;
    const { user } = await enrolled(`${local}@x.test`);
    expect(await rightPasswordAccepted({ ...user, email: `${local.toUpperCase()}@X.Test` })).toBe(true);
  });
});

describe('the lock keys on the account, not the client address (M0-007 review, D64)', () => {
  it('5 wrong passwords from 5 different addresses still lock the account', async () => {
    const { user } = await enrolled();
    for (let i = 1; i <= 5; i++) await wrong(user.email, `10.60.0.${i}`);
    expect(await rightPasswordAccepted(user, '10.60.0.99')).toBe(false);
  });

  it('a locked account does not lock out another account signing in from the same address', async () => {
    const shared = '10.61.0.1'; // everyone behind the front door can share one address
    const locked = await enrolled();
    const other = await enrolled();
    for (let i = 0; i < 5; i++) await wrong(locked.user.email, shared);
    expect(await rightPasswordAccepted(locked.user, shared)).toBe(false);
    expect(await rightPasswordAccepted(other.user, shared)).toBe(true);
    await signInFull(e().app, other.user, other.mfa, shared);
  });

  it("wrong passwords for other accounts don't count toward this account's lock", async () => {
    const shared = '10.62.0.1';
    const target = await enrolled();
    for (let i = 0; i < 6; i++) {
      const bystander = await seedUser(e().k, org);
      await wrong(bystander.email, shared);
    }
    expect(await rightPasswordAccepted(target.user, shared)).toBe(true);
  });
});

// From M0-010's security review (D54): guesses sent at the same time must not slip past the lock.
// The lock has to count an attempt before its password is checked. The review's repro sent 40
// sign-ins at once for one account (39 wrong, then the right one) and got every one of them
// checked, with the right one accepted.
describe('guesses sent at the same time (M0-010 security review, D54)', () => {
  it('39 wrong + 1 right sent at once: at most 5 are checked, the account locks, and the right one is refused', async () => {
    const address = '10.63.0.1'; // its own address, so the 300/min limit plays no part
    const { user } = await enrolled();

    // What a checked wrong password looks like, taken from a different account.
    const probe = await enrolled();
    const checkedWrong = await signInPassword(
      e().app,
      new Jar(),
      probe.user.email,
      'Definitely-wrong-password-1',
      '10.63.0.2',
    );
    expect(checkedWrong.statusCode, show(checkedWrong)).toBeGreaterThanOrEqual(400);
    const wrongAnswer = answerOf(checkedWrong);

    // The right password goes last, after the 39 wrong ones.
    const passwords = [...Array.from({ length: 39 }, (_, i) => `Burst-wrong-password-${i}-x`), user.password];
    let burst: Awaited<ReturnType<typeof signInPassword>>[] = [];
    const added = await auditDuring(e().k, org.id, async () => {
      burst = await Promise.all(passwords.map((pw) => signInPassword(e().app, new Jar(), user.email, pw, address)));
    });
    const right = burst[39]!;

    // After the burst the account is locked: this is what a lock refusal looks like.
    const after = await signInPassword(e().app, new Jar(), user.email, user.password, address);
    expect(wantsSecondFactor(after), `the account must be locked after the burst: ${show(after)}`).toBe(false);
    expect(after.statusCode, show(after)).toBeGreaterThanOrEqual(400);
    const lockAnswer = answerOf(after);
    expect(lockAnswer, 'a lock refusal is told apart from a checked wrong password').not.toBe(wrongAnswer);

    const answers = burst.map(answerOf);
    const tally: Record<string, number> = {};
    for (const a of answers) tally[a] = (tally[a] ?? 0) + 1;
    const checked = answers.filter((a) => a !== lockAnswer).length;
    expect(checked, `at most 5 passwords are checked; answers: ${JSON.stringify(tally)}`).toBeLessThanOrEqual(5);
    for (const a of answers) expect([wrongAnswer, lockAnswer], `answers: ${JSON.stringify(tally)}`).toContain(a);
    expect(wantsSecondFactor(right), `the right password in the burst must be refused: ${show(right)}`).toBe(false);
    expect(right.statusCode, show(right)).toBeGreaterThanOrEqual(400);

    // Every attempt is still audited, the lock is written once, and no password counted as right.
    const acts = actions(added);
    expect(acts.filter((a) => a === 'auth.sign_in_failed').length, JSON.stringify(acts)).toBe(40);
    expect(acts.filter((a) => a === 'auth.locked')).toEqual(['auth.locked']);
    expect(acts).not.toContain('auth.password_verified');
    expect(acts).not.toContain('auth.sign_in');

    // Still locked 14 min 59 s on.
    advance(14 * MINUTE + 59_000);
    expect(await rightPasswordAccepted(user, address)).toBe(false);
  });
});

function answerOf(res: Awaited<ReturnType<typeof signInPassword>>): string {
  return wantsSecondFactor(res) ? 'second factor' : `${res.statusCode} ${String(errorCode(res))}`;
}
