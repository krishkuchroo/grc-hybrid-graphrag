// M0-011 criterion 6 (D54: every key has an expiry; one role per key), with a fake clock.
// 6. Expiry is required and must be in the future.
// A refused create is 400 in the one error format (D47), makes no key and writes no
// `api_key.created`. The role must be one of the 7 roles (D50).
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, freezeClock, json, realClock, seedOrg, show, type Org, type SignedIn } from '../auth/helpers.js';
import { expectErrorFormat } from '../platform/helpers.js';
import {
  admin,
  createKeyRaw,
  inDays,
  keyAuditDuring,
  listKeys,
  onlyKeyEvents,
  setUpKeys,
  tearDownKeys,
  useKey,
  type CreateBody,
  type KeyEnv,
} from './helpers.js';

let env: KeyEnv | undefined;
let org: Org;
let a: SignedIn;

beforeAll(async () => {
  env = await setUpKeys();
  org = await seedOrg(env.k, 'Keys Validation Org');
  a = await admin(env.k, env.app, org);
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

async function total(): Promise<number> {
  const res = await listKeys(e().app, a, '?pageSize=100');
  expect(res.statusCode, show(res)).toBe(200);
  return Number(json(res).total ?? -1);
}

async function expectRefused(body: CreateBody): Promise<void> {
  const before = await total();
  const added = await keyAuditDuring(e().k, org.id, async () => {
    const res = await createKeyRaw(e().app, a, body);
    expectErrorFormat(res, 400);
    expect(res.body).not.toMatch(/grc_[A-Za-z0-9_-]{8,}/);
  });
  expect(onlyKeyEvents(added).map((ev) => ev.action)).not.toContain('api_key.created');
  expect(await total()).toBe(before);
}

describe('criterion 6: expiry is required', () => {
  it('no expiresAt: 400', async () => {
    await expectRefused({ name: 'no-expiry', role: 'viewer' });
  });

  it.each([null, '', 'next tuesday', 'not-a-date', 12345, true, {}])('expiresAt %j: 400', async (value) => {
    await expectRefused({ name: 'bad-expiry', role: 'viewer', expiresAt: value });
  });
});

describe('criterion 6: expiry must be in the future', () => {
  it('one second in the past: 400', async () => {
    await expectRefused({ name: 'past', role: 'viewer', expiresAt: new Date(Date.now() - 1000).toISOString() });
  });

  it('a year in the past: 400', async () => {
    await expectRefused({ name: 'long-past', role: 'viewer', expiresAt: inDays(-365) });
  });

  it('exactly now: 400', async () => {
    freezeClock();
    await expectRefused({ name: 'now', role: 'viewer', expiresAt: new Date(Date.now()).toISOString() });
  });

  it('a minute in the future: 201, and the key works', async () => {
    const res = await createKeyRaw(e().app, a, {
      name: 'soon',
      role: 'viewer',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(res.statusCode, show(res)).toBe(201);
    const use = await useKey(e().app, String(json(res).key));
    expect(use.statusCode, show(use)).toBe(200);
  });
});

describe('criterion 6: one of the 7 roles', () => {
  it.each(ROLES)('role %s: 201', async (role) => {
    const res = await createKeyRaw(e().app, a, { name: `role-${role}`, role, expiresAt: inDays(30) });
    expect(res.statusCode, show(res)).toBe(201);
  });

  it.each(['superuser', 'Admin', '', 'platform', null])('role %j: 400', async (role) => {
    await expectRefused({ name: 'bad-role', role, expiresAt: inDays(30) });
  });

  it('no role: 400', async () => {
    await expectRefused({ name: 'no-role', expiresAt: inDays(30) });
  });
});
