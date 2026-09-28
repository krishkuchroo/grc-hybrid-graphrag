// M0-011 criterion 4 (D4, D50, D54, D59: every role-table cell the key touches, every org pair).
// 4. A key never works for another org, and its role limits what it can do (M0-008 guard).
// A key runs as its own org and role with clearance `internal`, whatever the request says. Its role
// goes through the same `@Requires` + `AccessGuard` as a signed-in user's.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES, json, seedOrg, show, type Org, type Role, type SignedIn } from '../auth/helpers.js';
import { expectErrorFormat } from '../platform/helpers.js';
import {
  GUARDED,
  KEY_PROBE,
  admin,
  createKey,
  guardedCalls,
  listKeys,
  principalOf,
  revokeKey,
  setUpKeys,
  tearDownKeys,
  useKey,
  type KeyEnv,
  type NewKey,
} from './helpers.js';

let env: KeyEnv | undefined;
const orgs: Org[] = [];
const admins = new Map<string, SignedIn>();
const keysByOrgRole = new Map<string, NewKey>();

beforeAll(async () => {
  env = await setUpKeys();
  for (const name of ['Keys Org A', 'Keys Org B', 'Keys Org C']) orgs.push(await seedOrg(env.k, name));
}, 180_000);

afterAll(async () => {
  await tearDownKeys(env);
});

function e(): KeyEnv {
  if (!env) throw new Error('the API app did not start (see beforeAll)');
  return env;
}

async function adminOf(org: Org): Promise<SignedIn> {
  let a = admins.get(org.id);
  if (!a) {
    a = await admin(e().k, e().app, org);
    admins.set(org.id, a);
  }
  return a;
}

async function keyOf(org: Org, role: Role): Promise<NewKey> {
  const id = `${org.id}/${role}`;
  let key = keysByOrgRole.get(id);
  if (!key) {
    key = await createKey(e().app, await adminOf(org), { role, name: `${role}-key` });
    keysByOrgRole.set(id, key);
  }
  return key;
}

type Pair = { from: number; to: number; label: string };
const PAIRS: Pair[] = [];
for (let a = 0; a < 3; a++) {
  for (let b = 0; b < 3; b++) {
    if (a !== b) PAIRS.push({ from: a, to: b, label: `${'ABC'[a]} -> ${'ABC'[b]}` });
  }
}

const ORG_HEADERS = ['x-org-id', 'x-organization-id', 'x-active-organization-id', 'org-id', 'x-tenant-id'];

describe('criterion 4: a key runs as its own org, role and clearance internal', () => {
  it.each(ROLES)('a %s key', async (role) => {
    const key = await keyOf(orgs[0]!, role);
    const res = await useKey(e().app, key);
    expect(res.statusCode, show(res)).toBe(200);
    expect(principalOf(res)).toMatchObject({ orgId: orgs[0]!.id, role, clearance: 'internal' });
  });
});

describe('criterion 4: a key never works for another org', () => {
  it.each(PAIRS)("$label: another org's ID in headers is ignored", async ({ from, to }) => {
    const key = await keyOf(orgs[from]!, 'admin');
    const headers = Object.fromEntries(ORG_HEADERS.map((h) => [h, orgs[to]!.id]));
    const res = await useKey(e().app, key, { headers });
    expect(res.statusCode, show(res)).toBe(200);
    expect(principalOf(res)?.orgId).toBe(orgs[from]!.id);
  });

  it.each(PAIRS)("$label: another org's ID in the body or query is ignored", async ({ from, to }) => {
    const key = await keyOf(orgs[from]!, 'admin');
    const b = orgs[to]!.id;
    const res = await useKey(e().app, key, {
      method: 'POST',
      url: `${KEY_PROBE}/whoami?orgId=${b}&organizationId=${b}`,
      payload: { orgId: b, organizationId: b, org_id: b, activeOrganizationId: b },
    });
    expect(res.statusCode, show(res)).toBeLessThan(300);
    expect(principalOf(res)?.orgId).toBe(orgs[from]!.id);
  });

  it.each(PAIRS)("$label: an Admin lists none of the other org's keys", async ({ from, to }) => {
    const theirs = await keyOf(orgs[to]!, 'viewer');
    const res = await listKeys(e().app, await adminOf(orgs[from]!), '?pageSize=100');
    expect(res.statusCode, show(res)).toBe(200);
    expect(res.body).not.toContain(theirs.id);
    const items = (json(res).items ?? []) as { id: string }[];
    for (const item of items) {
      const own = [...keysByOrgRole.values()].find((k) => k.id === item.id);
      if (own) expect(own.orgId).toBe(orgs[from]!.id);
    }
  });

  it.each(PAIRS)(
    "$label: an Admin can't revoke the other org's key (404), and it keeps working",
    async ({ from, to }) => {
      const theirs = await createKey(e().app, await adminOf(orgs[to]!), { role: 'viewer' });
      const res = await revokeKey(e().app, await adminOf(orgs[from]!), theirs.id);
      const body = expectErrorFormat(res, 404);
      expect(body.error.code).toBe('not_found');
      const use = await useKey(e().app, theirs);
      expect(use.statusCode, show(use)).toBe(200);
      expect(principalOf(use)?.orgId).toBe(orgs[to]!.id);
    },
  );

  it("revoking another org's key and an unknown ID look the same", async () => {
    const theirs = await createKey(e().app, await adminOf(orgs[1]!));
    const mine = await adminOf(orgs[0]!);
    const other = await revokeKey(e().app, mine, theirs.id);
    const unknown = await revokeKey(e().app, mine, '5f0c2d1e-9a8b-4c7d-8e6f-1a2b3c4d5e6f');
    expect(other.statusCode).toBe(unknown.statusCode);
    expect((json(other).error as { code?: string }).code).toBe((json(unknown).error as { code?: string }).code);
  });
});

const CASES = GUARDED.flatMap((route) =>
  ROLES.map((role) => ({ ...route, role, allowed: route.allowed.includes(role) })),
);

describe('criterion 4: the key role limits what it can do (D50 table, M0-008 guard)', () => {
  it.each(CASES)('$method $path ($subject/$action) with a $role key -> allowed: $allowed', async (c) => {
    const key = await keyOf(orgs[0]!, c.role as Role);
    const label = `${c.method} ${c.path}`;
    const before = guardedCalls.get(label) ?? 0;
    const res = await useKey(e().app, key, {
      method: c.method,
      url: `${KEY_PROBE}/guarded/${c.path}`,
      ...(c.method === 'POST' ? { payload: {} } : {}),
    });
    if (c.allowed) {
      expect(res.statusCode, show(res)).toBeLessThan(300);
      expect(json(res)).toEqual({ ok: true, route: label });
      expect(guardedCalls.get(label)).toBe(before + 1);
    } else {
      const body = expectErrorFormat(res, 403);
      expect(body.error.code).toBe('forbidden');
      expect(guardedCalls.get(label) ?? 0, 'the handler must not run').toBe(before);
    }
  });
});
