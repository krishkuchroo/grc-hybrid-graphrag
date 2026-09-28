// M0-011 criterion 3 (D54: expiry, revocable; D47 error format), with a fake clock for expiry.
// 3. Expired and revoked keys get 401 at once.
// "At once" means the very next request after the expiry time or the revoke: nothing is cached.
// Unknown and malformed keys get the same 401.
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { HOUR, MINUTE, advance, freezeClock, realClock, seedOrg, show, type Org } from '../auth/helpers.js';
import { expectErrorFormat } from '../platform/helpers.js';
import {
  GUARDED,
  KEY_PROBE,
  admin,
  createKey,
  mustRevoke,
  principalOf,
  setUpKeys,
  tearDownKeys,
  useKey,
  type KeyEnv,
} from './helpers.js';

let env: KeyEnv | undefined;
let org: Org;

beforeAll(async () => {
  env = await setUpKeys();
  org = await seedOrg(env.k, 'Keys Expiry Org');
}, 180_000);

afterAll(async () => {
  realClock();
  await tearDownKeys(env);
});

afterEach(() => realClock());

function e(): KeyEnv {
  if (!env) throw new Error('the API app did not start (see beforeAll)');
  return env;
}

function expect401(res: Awaited<ReturnType<typeof useKey>>): void {
  expectErrorFormat(res, 401);
  expect(principalOf(res)).toBeNull();
}

describe('criterion 3: an expired key', () => {
  it('works until its expiry time, and gets 401 from the first request after it', async () => {
    freezeClock();
    const a = await admin(e().k, e().app, org);
    const expiresAt = new Date(Date.now() + HOUR).toISOString();
    const made = await createKey(e().app, a, { expiresAt });

    const fresh = await useKey(e().app, made);
    expect(fresh.statusCode, show(fresh)).toBe(200);

    advance(HOUR - MINUTE);
    const nearly = await useKey(e().app, made);
    expect(nearly.statusCode, show(nearly)).toBe(200);

    advance(MINUTE + 1);
    expect401(await useKey(e().app, made));
  });

  it('stays refused later on, on every route', async () => {
    freezeClock();
    const a = await admin(e().k, e().app, org);
    const made = await createKey(e().app, a, { role: 'admin', expiresAt: new Date(Date.now() + MINUTE).toISOString() });
    expect((await useKey(e().app, made)).statusCode).toBe(200);
    advance(2 * MINUTE);
    expect401(await useKey(e().app, made));
    for (const route of GUARDED) {
      const res = await useKey(e().app, made, {
        method: route.method,
        url: `${KEY_PROBE}/guarded/${route.path}`,
        ...(route.method === 'POST' ? { payload: {} } : {}),
      });
      expectErrorFormat(res, 401);
    }
    advance(30 * 24 * HOUR);
    expect401(await useKey(e().app, made));
  });
});

describe('criterion 3: a revoked key', () => {
  it('gets 401 on the very next request after the revoke', async () => {
    const a = await admin(e().k, e().app, org);
    const made = await createKey(e().app, a);
    for (let i = 0; i < 3; i++) expect((await useKey(e().app, made)).statusCode).toBe(200);
    await mustRevoke(e().app, a, made.id);
    expect401(await useKey(e().app, made));
    expect401(await useKey(e().app, made));
  });

  it('revoking one key leaves the org’s other keys working', async () => {
    const a = await admin(e().k, e().app, org);
    const gone = await createKey(e().app, a);
    const kept = await createKey(e().app, a);
    await mustRevoke(e().app, a, gone.id);
    expect401(await useKey(e().app, gone));
    const res = await useKey(e().app, kept);
    expect(res.statusCode, show(res)).toBe(200);
  });

  it('is refused on guarded routes too, even with the admin role', async () => {
    const a = await admin(e().k, e().app, org);
    const made = await createKey(e().app, a, { role: 'admin' });
    await mustRevoke(e().app, a, made.id);
    for (const route of GUARDED) {
      const res = await useKey(e().app, made, {
        method: route.method,
        url: `${KEY_PROBE}/guarded/${route.path}`,
        ...(route.method === 'POST' ? { payload: {} } : {}),
      });
      expectErrorFormat(res, 401);
    }
  });
});

describe('criterion 3: keys that match nothing', () => {
  it.each([
    ['an unknown grc_ key', `grc_${'A'.repeat(43)}`],
    ['a bare grc_ prefix', 'grc_'],
    ['something that is not a key', 'not-a-key'],
    ['an empty bearer', ''],
  ])('%s gets 401', async (_label, value) => {
    expect401(await useKey(e().app, value));
  });

  it('a real key with one character changed gets 401', async () => {
    const a = await admin(e().k, e().app, org);
    const made = await createKey(e().app, a);
    const last = made.key.slice(-1);
    const changed = made.key.slice(0, -1) + (last === 'A' ? 'B' : 'A');
    expect401(await useKey(e().app, changed));
    expect401(await useKey(e().app, made.key + 'x'));
    expect401(await useKey(e().app, made.key.slice(0, -1)));
  });
});
