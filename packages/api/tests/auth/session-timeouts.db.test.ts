// M0-010 criterion 3 (D54), with a fake clock.
// 3. A session ends after 30 min without requests, and after 12 h regardless of activity.
// An ended session gets 401 in the error format (D47), on our routes and on the probe.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectErrorFormat } from '../platform/helpers.js';
import {
  HOUR,
  ME,
  MINUTE,
  PROBE,
  advance,
  call,
  freezeClock,
  mfaUser,
  realClock,
  seedOrg,
  setUpAuth,
  show,
  signInFull,
  tearDownAuth,
  type AuthEnv,
  type Jar,
  type Org,
} from './helpers.js';

let env: AuthEnv | undefined;
let org: Org;

beforeAll(async () => {
  env = await setUpAuth();
  org = await seedOrg(env.k, 'Session Org');
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

async function freshSession(): Promise<Jar> {
  const { user, mfa } = await mfaUser(e().k, e().app, org);
  advance(MINUTE); // a new TOTP step, so the sign-in code differs from the enrolment code
  return signInFull(e().app, user, mfa);
}

async function expectOk(jar: Jar, when: string): Promise<void> {
  const res = await call(e().app, jar, { url: `${PROBE}/whoami` });
  expect(res.statusCode, `${when}: ${show(res)}`).toBe(200);
}

describe('criterion 3: 30 minutes idle', () => {
  it('a session used every 29 minutes stays alive', async () => {
    const jar = await freshSession();
    for (let i = 1; i <= 4; i++) {
      advance(29 * MINUTE);
      await expectOk(jar, `after ${i} × 29 min`);
    }
  });

  it('ends after 31 minutes without a request', async () => {
    const jar = await freshSession();
    advance(10 * MINUTE);
    await expectOk(jar, 'after 10 min');
    advance(31 * MINUTE);
    expectErrorFormat(await call(e().app, jar, { url: `${PROBE}/whoami` }), 401);
    expectErrorFormat(await call(e().app, jar, { url: ME }), 401);
  });

  it('an idle-ended session stays ended: requests afterwards do not revive it', async () => {
    const jar = await freshSession();
    advance(31 * MINUTE);
    expectErrorFormat(await call(e().app, jar, { url: `${PROBE}/whoami` }), 401);
    advance(1 * MINUTE);
    expectErrorFormat(await call(e().app, jar, { url: `${PROBE}/whoami` }), 401);
  });

  it('only real requests count as activity: a session untouched for 31 minutes ends even if others are busy', async () => {
    const idle = await freshSession();
    const busy = await freshSession();
    for (let i = 0; i < 3; i++) {
      advance(11 * MINUTE);
      await expectOk(busy, `busy session after ${(i + 1) * 11} min`);
    }
    const res = await call(e().app, idle, { url: `${PROBE}/whoami` });
    expect(res.statusCode, show(res)).toBe(401);
  });
});

describe('criterion 3: 12 hours at most', () => {
  it('ends 12 hours after sign-in even when used every 20 minutes', async () => {
    const jar = await freshSession();
    let elapsed = 0;
    while (elapsed + 20 * MINUTE < 12 * HOUR) {
      advance(20 * MINUTE);
      elapsed += 20 * MINUTE;
      await expectOk(jar, `at ${elapsed / MINUTE} min`);
    }
    // 11 h 40 min so far; 21 more minutes is inside the idle limit but past 12 h.
    advance(21 * MINUTE);
    expectErrorFormat(await call(e().app, jar, { url: `${PROBE}/whoami` }), 401);
    expectErrorFormat(await call(e().app, jar, { url: ME }), 401);
  }, 120_000);

  it('is still alive at 11 h 59 min with recent activity', async () => {
    const jar = await freshSession();
    let elapsed = 0;
    while (elapsed + 25 * MINUTE <= 11 * HOUR + 59 * MINUTE) {
      advance(25 * MINUTE);
      elapsed += 25 * MINUTE;
      await expectOk(jar, `at ${elapsed / MINUTE} min`);
    }
    advance(11 * HOUR + 59 * MINUTE - elapsed);
    await expectOk(jar, 'at 11 h 59 min');
  }, 120_000);
});
