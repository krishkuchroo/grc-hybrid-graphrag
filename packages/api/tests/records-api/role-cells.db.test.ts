// S1-004 criterion 2 (D59, every role cell; D50, D199): for each of the 7 roles x 5 kinds x 5
// routes, the answer matches ROLE_TABLE. The cases are generated from ROLE_TABLE, ROLES and
// RECORD_KINDS, so the matrix can't drift.
// - `edit`: every route allowed. `view`: list and get allowed, create/update/retire 403.
// - `none`: every route 403 (the guard refuses; the handler never runs).
// - `edit_own` (a Control Owner on controls): list, get, update and retire allowed only on controls
//   they own (a control they don't own is 404, and never listed); POST /api/v1/controls is 403 (D199).
// Every record here is labelled `public` and every caller has clearance `restricted`, so only the
// role decides. A refused change leaves the stored record as it was; a refused create saves nothing.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  RECORD_KINDS,
  ROLES,
  ROUTES,
  T,
  createR,
  expectRefused,
  expectUnchanged,
  expectedFor,
  countNamed,
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
let org: Org;
const people = new Map<Role, SignedIn>();

beforeAll(async () => {
  env = await setUpRecordsApi();
  org = await newApiOrg(env, 'Records Api Roles');
  for (const role of ROLES) people.set(role, await person(env, org, role, 'restricted'));
}, LONG);

afterAll(async () => {
  await tearDownRecordsApi(env);
}, LONG);

function e(): ApiEnv {
  if (!env) throw new Error('set-up did not finish (see beforeAll)');
  return env;
}

function who(role: Role): SignedIn {
  const p = people.get(role);
  if (!p) throw new Error(`no signed-in ${role} (see beforeAll)`);
  return p;
}

/** A fresh `public` record made by the Admin, owned by `owner` (the Admin by default). */
function fresh(kind: RecordKind, owner?: string): Promise<RecordOut> {
  return seed(e(), who('admin'), kind, { label: 'public', ...(owner ? { owner } : {}) });
}

async function run(role: Role, kind: RecordKind, route: Route, rec: RecordOut) {
  const me = who(role);
  switch (route) {
    case 'list':
      return listR(e(), me, kind, '?status=all&pageSize=100');
    case 'get':
      return getR(e(), me, kind, rec.id);
    case 'create':
      return createR(e(), me, kind, validInput(kind, { label: 'public' }));
    case 'update':
      return patchR(e(), me, kind, rec.id, { ...fieldChange(kind), version: rec.version });
    case 'retire':
      return retireR(e(), me, kind, rec.id, rec.version);
  }
}

/** Checks an allowed answer for each route. */
async function expectAllowed(role: Role, kind: RecordKind, route: Route, rec: RecordOut): Promise<void> {
  const res = await run(role, kind, route, rec);
  switch (route) {
    case 'list':
      expect(res.statusCode, show(res)).toBe(200);
      expect((json(res).items as { id: string }[]).map((i) => i.id)).toContain(rec.id);
      break;
    case 'get':
      expect(res.statusCode, show(res)).toBe(200);
      expect(json(res)).toMatchObject({ id: rec.id, number: rec.number, name: rec.name, label: 'public' });
      break;
    case 'create': {
      expect(res.statusCode, show(res)).toBe(201);
      const body = json(res) as unknown as RecordOut;
      expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(body).toMatchObject({ status: 'active', version: 1, label: 'public', owner: who(role).user.id });
      expect(await countNamed(e(), org.id, kind, body.name)).toBe(1);
      break;
    }
    case 'update':
      expect(res.statusCode, show(res)).toBe(200);
      expect(json(res)).toMatchObject({ id: rec.id, version: rec.version + 1, ...fieldChange(kind) });
      break;
    case 'retire':
      expect(res.statusCode, show(res)).toBe(200);
      expect(json(res)).toMatchObject({ id: rec.id, status: 'retired', version: rec.version + 1 });
      break;
  }
}

/** Checks a refusal: the answer, and that nothing changed or was made. */
async function expectRefusal(role: Role, kind: RecordKind, route: Route, rec: RecordOut, status: number) {
  if (route === 'create') {
    const body = validInput(kind, { label: 'public' });
    const res = await createR(e(), who(role), kind, body);
    expectRefused(res, status, status === 403 ? 'forbidden' : 'not_found');
    expect(await countNamed(e(), org.id, kind, body.name as string), 'nothing was created').toBe(0);
    return;
  }
  const res = await run(role, kind, route, rec);
  expectRefused(res, status, status === 403 ? 'forbidden' : 'not_found');
  await expectUnchanged(e(), org.id, kind, rec);
}

const CASES = ROLES.flatMap((role) =>
  RECORD_KINDS.flatMap((kind) =>
    ROUTES.map((route) => ({ role, kind, route, expected: expectedFor(role, kind, route) })),
  ),
);

describe('criterion 2: every role x kind x route answers as ROLE_TABLE says (D50, D59)', { timeout: T }, () => {
  it('covers 7 roles x 5 kinds x 5 routes', () => {
    expect(CASES).toHaveLength(175);
  });

  it.each(CASES.filter((c) => c.expected !== 'own'))(
    '$role $route $kind -> $expected',
    async ({ role, kind, route, expected }) => {
      const rec = await fresh(kind);
      if (expected === 'ok') await expectAllowed(role, kind, route, rec);
      else await expectRefusal(role, kind, route, rec, 403);
    },
  );

  describe('the "own" cells: a Control Owner on controls (D50, D199)', () => {
    const OWN = CASES.filter((c) => c.expected === 'own');

    it('the table has own cells for control_owner on controls only', () => {
      expect(OWN.map((c) => `${c.role}/${c.kind}`)).toEqual(
        ['list', 'get', 'update', 'retire'].map(() => 'control_owner/control'),
      );
    });

    it.each(OWN)('$role $route on a control they own -> allowed', async ({ role, kind, route }) => {
      const rec = await fresh(kind, who(role).user.id);
      await expectAllowed(role, kind, route, rec);
    });

    it.each(OWN)("$role $route on a control they don't own -> 404, unchanged", async ({ role, kind, route }) => {
      const rec = await fresh(kind);
      if (route === 'list') {
        const ids = await listIds(e(), who(role), kind);
        expect(ids).not.toContain(rec.id);
        return;
      }
      await expectRefusal(role, kind, route, rec, 404);
    });

    it('POST /api/v1/controls is 403 for a Control Owner, even naming themselves as owner (D199)', async () => {
      const me = who('control_owner');
      const body = validInput('control', { label: 'public', owner: me.user.id });
      const res = await createR(e(), me, 'control', body);
      expectRefused(res, 403, 'forbidden');
      expect(await countNamed(e(), org.id, 'control', body.name as string)).toBe(0);
    });

    it("a Control Owner's list shows exactly their own controls", async () => {
      const mine = await fresh('control', who('control_owner').user.id);
      const theirs = await fresh('control');
      const ids = await listIds(e(), who('control_owner'), 'control');
      expect(ids).toContain(mine.id);
      expect(ids).not.toContain(theirs.id);
      const res = await listR(e(), who('control_owner'), 'control', '?status=all&pageSize=100');
      expect(res.statusCode, show(res)).toBe(200);
      expect(json(res).total).toBe(ids.length);
    });
  });
});
