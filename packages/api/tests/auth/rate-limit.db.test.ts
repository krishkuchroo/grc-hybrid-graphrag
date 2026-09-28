// From M0-007's security review (D64): the 300 requests a minute limit is per person. Behind
// Caddy many people share one client address, so once someone is signed in their counter is
// their own, not the address's. With a fake clock, so the minute windows are exact.
// - Two signed-in users on one address each get their own 300.
// - One signed-in user on several addresses shares one counter.
// - A made-up session cookie is not a person: it can't buy a fresh counter.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectErrorFormat } from '../platform/helpers.js';
import {
  MINUTE,
  PROBE,
  Jar,
  advance,
  call,
  freezeClock,
  mfaUser,
  realClock,
  seedOrg,
  setUpAuth,
  show,
  tearDownAuth,
  type AuthEnv,
  type Org,
  type SignedIn,
} from './helpers.js';

let env: AuthEnv | undefined;
let org: Org;

beforeAll(async () => {
  env = await setUpAuth();
  org = await seedOrg(env.k, 'Rate Org');
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

async function twoUsers(): Promise<[SignedIn, SignedIn]> {
  const a = await mfaUser(e().k, e().app, org);
  const b = await mfaUser(e().k, e().app, org);
  advance(2 * MINUTE); // start every counter afresh
  return [a, b];
}

async function hit(p: Jar | undefined, remoteAddress: string): Promise<number> {
  return (await call(e().app, p, { url: `${PROBE}/whoami`, remoteAddress })).statusCode;
}

describe('D64: the per-person limit follows the signed-in user', () => {
  it('two users on one address each get 300; the 301st of one is refused and the other still gets through', async () => {
    const [a, b] = await twoUsers();
    const shared = '10.70.0.1';
    for (let i = 1; i <= 300; i++) {
      const status = await hit(a.jar, shared);
      if (status !== 200) throw new Error(`user A request ${i} got ${status}, expected 200`);
    }
    for (let i = 1; i <= 300; i++) {
      const status = await hit(b.jar, shared);
      if (status !== 200) throw new Error(`user B request ${i} on the same address got ${status}, expected 200`);
    }
    const res = await call(e().app, a.jar, { url: `${PROBE}/whoami`, remoteAddress: shared });
    expectErrorFormat(res, 429);
    const c = await mfaUser(e().k, e().app, org);
    expect(await hit(c.jar, shared), 'a third user on the same address').toBe(200);
  }, 120_000);

  it('one user on several addresses shares one counter', async () => {
    const [a] = await twoUsers();
    for (let i = 1; i <= 300; i++) {
      const status = await hit(a.jar, `10.71.0.${(i % 3) + 1}`);
      if (status !== 200) throw new Error(`request ${i} got ${status}, expected 200`);
    }
    const res = await call(e().app, a.jar, { url: `${PROBE}/whoami`, remoteAddress: '10.71.0.200' });
    expectErrorFormat(res, 429);
  }, 120_000);

  it('a made-up session cookie does not buy a fresh counter: 301 forged cookies from one address are refused', async () => {
    advance(2 * MINUTE);
    const addr = '10.72.0.1';
    let last = 0;
    for (let i = 1; i <= 301; i++) {
      const jar = new Jar();
      jar.absorb({
        statusCode: 200,
        headers: {
          'set-cookie': [
            `better-auth.session_token=forged${i}.sig${i}`,
            `__Secure-better-auth.session_token=forged${i}.sig${i}`,
          ],
        },
        body: '',
        json: () => ({}),
      });
      const res = await call(e().app, jar, { url: `${PROBE}/whoami`, remoteAddress: addr });
      last = res.statusCode;
      if (i <= 300 && last === 429) throw new Error(`request ${i} was limited too early: ${show(res)}`);
    }
    expect(last).toBe(429);
  }, 120_000);

  it('a new minute starts a new count for the user', async () => {
    const [a] = await twoUsers();
    for (let i = 0; i < 301; i++) await hit(a.jar, '10.73.0.1');
    expect(await hit(a.jar, '10.73.0.1')).toBe(429);
    advance(61_000);
    expect(await hit(a.jar, '10.73.0.1')).toBe(200);
  }, 120_000);
});
