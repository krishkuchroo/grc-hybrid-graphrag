// S1-004 criterion 5 (D54, D59): API keys follow the same rules, with their one role, their one org
// and clearance `internal` (M0-011).
// - Every role x kind x route for a key, from ROLE_TABLE, on `internal` records. A Control Owner key
//   owns no control, so its control reads and changes are 404 and its list holds none of them; its
//   create is 403 (D199).
// - A record above `internal` is 404 for every key; a key can't create above `internal` (D198).
// - A key must name an owner when it creates a record (S1-003), and its audit actor is the key.
// - A key of org A can't reach org B: 404 on B's IDs, B's records never in A's lists.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createKey, type NewKey } from '../api-keys/helpers.js';
import {
  LONG,
  RECORD_KINDS,
  ROLES,
  ROUTES,
  T,
  countNamed,
  createR,
  expectRefused,
  expectUnchanged,
  expectedFor,
  fieldChange,
  getR,
  json,
  listIds,
  listR,
  newApiOrg,
  patchR,
  person,
  retireR,
  seed,
  setUpRecordsApi,
  show,
  storedNode,
  tearDownRecordsApi,
  validInput,
  type ApiEnv,
  type Org,
  type RecordKind,
  type RecordOut,
  type Role,
  type Route,
  type SignedIn,
} from './helpers.js';

let env: ApiEnv | undefined;
const orgs: Org[] = [];
const admins: SignedIn[] = [];
const keys = new Map<Role, NewKey>();
const orgKeys: NewKey[] = [];
const orgRecords: Record<RecordKind, RecordOut>[] = [];

beforeAll(async () => {
  env = await setUpRecordsApi();
  for (const name of ['Records Api Keys A', 'Records Api Keys B', 'Records Api Keys C']) {
    const org = await newApiOrg(env, name);
    orgs.push(org);
    const admin = await person(env, org, 'admin', 'restricted');
    admins.push(admin);
    orgKeys.push(await createKey(env.app, admin, { role: 'admin', name: `${name} admin key` }));
    const byKind = {} as Record<RecordKind, RecordOut>;
    for (const kind of RECORD_KINDS) byKind[kind] = await seed(env, admin, kind, { label: 'internal' });
    orgRecords.push(byKind);
  }
  for (const role of ROLES) keys.set(role, await createKey(env.app, admins[0]!, { role, name: `${role} key` }));
}, LONG);

afterAll(async () => {
  await tearDownRecordsApi(env);
}, LONG);

function e(): ApiEnv {
  if (!env) throw new Error('set-up did not finish (see beforeAll)');
  return env;
}

function keyOf(role: Role): NewKey {
  const key = keys.get(role);
  if (!key) throw new Error(`no ${role} key (see beforeAll)`);
  return key;
}

function fresh(kind: RecordKind, label = 'internal'): Promise<RecordOut> {
  return seed(e(), admins[0]!, kind, { label });
}

/** A key owns nothing, so the "own" cells behave as "not own": 404 on an ID, nothing listed. */
function keyExpected(role: Role, kind: RecordKind, route: Route): 'ok' | 403 | 404 | 'none-listed' {
  const x = expectedFor(role, kind, route);
  if (x !== 'own') return x;
  return route === 'list' ? 'none-listed' : 404;
}

const CASES = ROLES.flatMap((role) =>
  RECORD_KINDS.flatMap((kind) =>
    ROUTES.map((route) => ({ role, kind, route, expected: keyExpected(role, kind, route) })),
  ),
);

describe('criterion 5: every role x kind x route with an API key (D54, D50, D59)', { timeout: T }, () => {
  it('covers 7 roles x 5 kinds x 5 routes', () => {
    expect(CASES).toHaveLength(175);
  });

  it.each(CASES)('$role key: $route $kind -> $expected', async ({ role, kind, route, expected }) => {
    const key = keyOf(role);
    const rec = await fresh(kind);
    const ownerId = admins[0]!.user.id;
    if (route === 'list' && expected !== 403) {
      const ids = await listIds(e(), key, kind);
      if (expected === 'ok') expect(ids).toContain(rec.id);
      else expect(ids).not.toContain(rec.id);
      return;
    }
    const body = validInput(kind, { label: 'internal', owner: ownerId });
    const res =
      route === 'list'
        ? await listR(e(), key, kind, '?status=all')
        : route === 'get'
          ? await getR(e(), key, kind, rec.id)
          : route === 'create'
            ? await createR(e(), key, kind, body)
            : route === 'update'
              ? await patchR(e(), key, kind, rec.id, { ...fieldChange(kind), version: rec.version })
              : await retireR(e(), key, kind, rec.id, rec.version);
    if (expected === 'ok') {
      expect(res.statusCode, show(res)).toBe(route === 'create' ? 201 : 200);
      if (route === 'get') expect(json(res)).toMatchObject({ id: rec.id });
      if (route === 'update') expect(json(res)).toMatchObject({ id: rec.id, version: rec.version + 1 });
      if (route === 'retire') expect(json(res)).toMatchObject({ id: rec.id, status: 'retired' });
      if (route === 'create') expect(json(res)).toMatchObject({ owner: ownerId, label: 'internal', version: 1 });
      return;
    }
    const status = expected === 403 ? 403 : 404;
    expectRefused(res, status, status === 403 ? 'forbidden' : 'not_found');
    if (route === 'create') expect(await countNamed(e(), orgs[0]!.id, kind, body.name as string)).toBe(0);
    else await expectUnchanged(e(), orgs[0]!.id, kind, rec);
  });
});

describe('criterion 5: a key has clearance internal (D51, D198)', { timeout: T }, () => {
  it.each(RECORD_KINDS)('an Admin key gets 404 on a confidential %s and never lists it', async (kind) => {
    const hidden = await fresh(kind, 'confidential');
    expectRefused(await getR(e(), keyOf('admin'), kind, hidden.id), 404, 'not_found');
    expect(await listIds(e(), keyOf('admin'), kind)).not.toContain(hidden.id);
  });

  it.each(RECORD_KINDS)('an Admin key creating a confidential %s is 403, nothing saved', async (kind) => {
    const body = validInput(kind, { label: 'confidential', owner: admins[0]!.user.id });
    expectRefused(await createR(e(), keyOf('admin'), kind, body), 403, 'forbidden');
    expect(await countNamed(e(), orgs[0]!.id, kind, body.name as string)).toBe(0);
  });

  it('an Admin key creating a record without an owner is 400, nothing saved', async () => {
    const body = validInput('risk', { label: 'internal' });
    expectRefused(await createR(e(), keyOf('admin'), 'risk', body), 400, 'validation_failed');
    expect(await countNamed(e(), orgs[0]!.id, 'risk', body.name as string)).toBe(0);
  });

  it("a key's create records the person it names as owner, and the key as creator", async () => {
    const key = keyOf('risk_manager');
    const res = await createR(e(), key, 'risk', validInput('risk', { label: 'internal', owner: admins[0]!.user.id }));
    expect(res.statusCode, show(res)).toBe(201);
    const node = await storedNode(e(), orgs[0]!.id, 'risk', (json(res) as { id: string }).id);
    expect(node?.['owner']).toBe(admins[0]!.user.id);
    expect(node?.['createdBy']).toBe(`api_key:${key.id}`);
  });
});

const PAIRS = [0, 1, 2].flatMap((a) =>
  [0, 1, 2].filter((b) => b !== a).map((b) => ({ a, b, pair: `${'ABC'[a]} -> ${'ABC'[b]}` })),
);
const PAIR_CASES = PAIRS.flatMap((p) => RECORD_KINDS.map((kind) => ({ ...p, kind })));

describe("criterion 5: a key of org A can't reach org B (D54, D55)", { timeout: T }, () => {
  it.each(PAIR_CASES)(
    "$pair $kind: GET, PATCH and retire of B's record are 404, B's record unchanged",
    async ({ a, b, kind }) => {
      const theirs = orgRecords[b]![kind];
      const key = orgKeys[a]!;
      expectRefused(await getR(e(), key, kind, theirs.id), 404, 'not_found');
      expectRefused(
        await patchR(e(), key, kind, theirs.id, { ...fieldChange(kind), version: theirs.version }),
        404,
        'not_found',
      );
      expectRefused(await retireR(e(), key, kind, theirs.id, theirs.version), 404, 'not_found');
      await expectUnchanged(e(), orgs[b]!.id, kind, theirs);
    },
  );

  it.each(PAIR_CASES)("$pair $kind: B's records never appear in the list of A's key", async ({ a, b, kind }) => {
    const ids = await listIds(e(), orgKeys[a]!, kind);
    expect(ids).toContain(orgRecords[a]![kind].id);
    expect(ids).not.toContain(orgRecords[b]![kind].id);
  });

  it.each(PAIR_CASES)("$pair $kind: A's key can't name B's user as owner (400)", async ({ a, b, kind }) => {
    const body = validInput(kind, { label: 'internal', owner: admins[b]!.user.id });
    expectRefused(await createR(e(), orgKeys[a]!, kind, body), 400, 'validation_failed');
    expect(await countNamed(e(), orgs[b]!.id, kind, body.name as string)).toBe(0);
  });
});
