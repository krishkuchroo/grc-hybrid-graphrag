// M0-011 criterion 1 (D50 "Users, roles, grants": Admin only; D54; D59 every role-table cell).
// 1. Only an Admin of the org can create, list or revoke keys.
// Every one of the 7 roles tries each of the three routes, signed in with MFA checked. Refusals are
// 403 in the one error format (D47), and change nothing. No session at all is 401.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  Jar,
  ROLES,
  call,
  json,
  mfaUser,
  seedOrg,
  seedUser,
  show,
  signInPassword,
  type Org,
  type Role,
} from '../auth/helpers.js';
import { expectErrorFormat } from '../platform/helpers.js';
import {
  KEYS,
  admin,
  createKey,
  createKeyRaw,
  inDays,
  listKeys,
  revokeKey,
  setUpKeys,
  tearDownKeys,
  useKey,
  type KeyEnv,
} from './helpers.js';

let env: KeyEnv | undefined;
let org: Org;

beforeAll(async () => {
  env = await setUpKeys();
  org = await seedOrg(env.k, 'Keys Admin Org');
}, 180_000);

afterAll(async () => {
  await tearDownKeys(env);
});

function e(): KeyEnv {
  if (!env) throw new Error('the API app did not start (see beforeAll)');
  return env;
}

const NON_ADMIN = ROLES.filter((r) => r !== 'admin');

describe('criterion 1: an Admin of the org can manage keys', () => {
  it('creates a key: 201 with { id, key }', async () => {
    const a = await admin(e().k, e().app, org);
    const res = await createKeyRaw(e().app, a, { name: 'connector-1', role: 'viewer', expiresAt: inDays(30) });
    expect(res.statusCode, show(res)).toBe(201);
    const body = json(res);
    expect(typeof body.id).toBe('string');
    expect(typeof body.key).toBe('string');
  });

  it('lists the org keys', async () => {
    const a = await admin(e().k, e().app, org);
    const made = await createKey(e().app, a, { name: 'listed-by-admin' });
    const res = await listKeys(e().app, a, '?pageSize=100');
    expect(res.statusCode, show(res)).toBe(200);
    const items = (json(res).items ?? []) as { id: string }[];
    expect(items.map((i) => i.id)).toContain(made.id);
  });

  it('revokes a key', async () => {
    const a = await admin(e().k, e().app, org);
    const made = await createKey(e().app, a);
    const res = await revokeKey(e().app, a, made.id);
    expect([200, 204], show(res)).toContain(res.statusCode);
  });
});

describe.each(NON_ADMIN)('criterion 1: a %s is refused', (role: Role) => {
  it('POST /api-keys: 403, and no key is made', async () => {
    const a = await admin(e().k, e().app, org);
    const before = (json(await listKeys(e().app, a, '?pageSize=100')).total ?? 0) as number;
    const p = await mfaUser(e().k, e().app, org, { role, clearance: 'restricted' });
    const res = await createKeyRaw(e().app, p, { name: `by-${role}`, role: 'viewer', expiresAt: inDays(30) });
    const body = expectErrorFormat(res, 403);
    expect(body.error.code).toBe('forbidden');
    expect(res.body).not.toMatch(/grc_[A-Za-z0-9_-]{8,}/);
    const after = (json(await listKeys(e().app, a, '?pageSize=100')).total ?? 0) as number;
    expect(after).toBe(before);
  });

  it('GET /api-keys: 403, and nothing is listed', async () => {
    const a = await admin(e().k, e().app, org);
    const made = await createKey(e().app, a, { name: `hidden-from-${role}` });
    const p = await mfaUser(e().k, e().app, org, { role, clearance: 'restricted' });
    const res = await listKeys(e().app, p);
    const body = expectErrorFormat(res, 403);
    expect(body.error.code).toBe('forbidden');
    expect(res.body).not.toContain(made.id);
    expect(res.body).not.toContain(`hidden-from-${role}`);
  });

  it('DELETE /api-keys/:id: 403, and the key still works', async () => {
    const a = await admin(e().k, e().app, org);
    const made = await createKey(e().app, a);
    const p = await mfaUser(e().k, e().app, org, { role, clearance: 'restricted' });
    const res = await revokeKey(e().app, p, made.id);
    const body = expectErrorFormat(res, 403);
    expect(body.error.code).toBe('forbidden');
    const use = await useKey(e().app, made);
    expect(use.statusCode, show(use)).toBe(200);
  });
});

describe('criterion 1: no session', () => {
  it.each([
    { method: 'POST', url: KEYS, payload: { name: 'anon', role: 'viewer', expiresAt: inDays(30) } },
    { method: 'GET', url: KEYS },
    { method: 'DELETE', url: `${KEYS}/00000000-0000-4000-8000-000000000000` },
  ])('$method $url without a session: 401', async ({ method, url, payload }) => {
    const res = await call(e().app, undefined, { method, url, ...(payload ? { payload } : {}) });
    expectErrorFormat(res, 401);
  });

  it('a signed-in Admin who has not finished MFA is refused', async () => {
    // A fresh admin with a password-only session (no MFA yet).
    const fresh = await seedUser(e().k, org, { role: 'admin', clearance: 'restricted' });
    const jar = new Jar();
    const signIn = await signInPassword(e().app, jar, fresh.email, fresh.password);
    expect(signIn.statusCode, show(signIn)).toBe(200);
    const res = await call(e().app, jar, {
      method: 'POST',
      url: KEYS,
      payload: { name: 'no-mfa', role: 'viewer', expiresAt: inDays(30) },
    });
    expect(res.statusCode, show(res)).toBe(403);
  });
});
