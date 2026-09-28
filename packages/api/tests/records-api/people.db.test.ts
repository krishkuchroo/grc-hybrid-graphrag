// S1-004 GET /api/v1/people (the owner picker; D47, D55, D54): any signed-in caller of any role gets
// their own org's members, paged like every list, each as `{ id, name, role }` only: no email and no
// clearance. Another org's members never appear. An API key sees its own org's members. No session
// is 401.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call } from '../auth/helpers.js';
import { createKey } from '../api-keys/helpers.js';
import {
  LONG,
  PREFIX,
  ROLES,
  T,
  expectRefused,
  json,
  newApiOrg,
  person,
  send,
  setUpRecordsApi,
  show,
  tearDownRecordsApi,
  type ApiEnv,
  type Org,
  type Role,
  type SignedIn,
  type Who,
} from './helpers.js';

const PEOPLE = `${PREFIX}/people`;

let env: ApiEnv | undefined;
let orgA: Org;
let orgB: Org;
const inA = new Map<Role, SignedIn>();
let inB: SignedIn[] = [];

beforeAll(async () => {
  env = await setUpRecordsApi();
  orgA = await newApiOrg(env, 'Records Api People A');
  orgB = await newApiOrg(env, 'Records Api People B');
  for (const role of ROLES) inA.set(role, await person(env, orgA, role, role === 'viewer' ? 'public' : 'confidential'));
  inB = [await person(env, orgB, 'admin'), await person(env, orgB, 'viewer')];
}, LONG);

afterAll(async () => {
  await tearDownRecordsApi(env);
}, LONG);

function e(): ApiEnv {
  if (!env) throw new Error('set-up did not finish (see beforeAll)');
  return env;
}

type Person = { id: string; name: string; role: string };
type Page = { items: Person[]; page: number; pageSize: number; total: number };

async function all(who: Who): Promise<Page> {
  const res = await send(e(), who, { url: `${PEOPLE}?pageSize=100` });
  expect(res.statusCode, show(res)).toBe(200);
  return json(res) as unknown as Page;
}

describe('GET /api/v1/people', { timeout: T }, () => {
  it.each(ROLES)('a signed-in %s gets 200 with exactly their org members', async (role) => {
    const page = await all(inA.get(role)!);
    const expected = [...inA.values()].map((p) => ({ id: p.user.id, name: p.user.name, role: p.user.role }));
    expect(page.items.map((p) => p.id).sort()).toEqual(expected.map((p) => p.id).sort());
    expect(page.total).toBe(ROLES.length);
    for (const want of expected) expect(page.items).toContainEqual(want);
  });

  it('each person is { id, name, role } only: no email, no clearance', async () => {
    const res = await send(e(), inA.get('viewer')!, { url: `${PEOPLE}?pageSize=100` });
    expect(res.statusCode, show(res)).toBe(200);
    const page = json(res) as unknown as Page;
    for (const p of page.items) expect(Object.keys(p).sort()).toEqual(['id', 'name', 'role']);
    for (const p of inA.values()) expect(res.body).not.toContain(p.user.email);
    expect(res.body).not.toMatch(/clearance|confidential|email/i);
  });

  it("another org's members never appear, in either direction", async () => {
    const a = await all(inA.get('admin')!);
    const b = await all(inB[0]!);
    for (const p of inB) expect(a.items.map((i) => i.id)).not.toContain(p.user.id);
    for (const p of inA.values()) expect(b.items.map((i) => i.id)).not.toContain(p.user.id);
    expect(b.items.map((i) => i.id).sort()).toEqual(inB.map((p) => p.user.id).sort());
  });

  it('is paged like every list', async () => {
    const res = await send(e(), inA.get('admin')!, { url: `${PEOPLE}?pageSize=3&page=2` });
    expect(res.statusCode, show(res)).toBe(200);
    expect(json(res)).toMatchObject({ page: 2, pageSize: 3, total: ROLES.length });
    expect((json(res).items as unknown[]).length).toBe(3);
    expectRefused(await send(e(), inA.get('admin')!, { url: `${PEOPLE}?page=0` }), 400);
  });

  it("an API key gets its own org's members only", async () => {
    const key = await createKey(e().app, inA.get('admin')!, { role: 'viewer', name: 'people key' });
    const page = await all(key);
    expect(page.items.map((p) => p.id).sort()).toEqual([...inA.values()].map((p) => p.user.id).sort());
  });

  it('without a session it is 401', async () => {
    expectRefused(await call(e().app, undefined, { url: PEOPLE }), 401);
  });
});
