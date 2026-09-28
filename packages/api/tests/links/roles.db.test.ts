// S1-005 criterion 5, every role cell (D59, D50, D200, D199): each role against each links route,
// with the expected answer worked out from the ROLE_TABLE cells (not through `can`), so the table
// and the routes can't drift apart.
// - GET /api/v1/<plural>/:id/links: the kind's cell 'none' is 403 (the guard); 'view' or 'edit' is
//   200; 'edit_own' (a Control Owner's controls) is 200 on an owned control and 404 on anyone
//   else's (S1-004's "own" pass-through, the service checks ownership).
// - GET /api/v1/assets/:id/map: every role may view assets, so 200.
// - POST /api/v1/links, for every role x each of the spec's link types: 404 when the caller can't
//   see an end, else 403 when they can edit neither end (D200), else 201.
// - The 7 routes are in the OpenAPI document.
// Everyone here has clearance restricted and every record is labelled internal, so only the role
// decides; clearance x label is in clearance.db.test.ts.
import { LINK_TYPES, ROLE_TABLE } from '@grc/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, json } from '../auth/helpers.js';
import {
  KINDS,
  answered,
  LONG,
  RECORD_PATHS,
  ROLES,
  T,
  cellOf,
  getLinks,
  getMap,
  makeRecord,
  mayEdit,
  mayView,
  newLinksOrg,
  person,
  postLink,
  setUpLinks,
  show,
  storedLinks,
  tearDownLinks,
  type LinksEnv,
  type Person,
  type Rec,
  type RecordKind,
  type Role,
} from './helpers.js';

const TABLE = ROLE_TABLE as unknown as Record<string, Record<string, string>>;

let env: LinksEnv;
let orgId: string;
const people = {} as Record<Role, Person>;

beforeAll(async () => {
  env = await setUpLinks();
  const org = await newLinksOrg(env, 'Links Roles');
  orgId = org.id;
  for (const role of ROLES) people[role] = await person(env, org, role, 'restricted');
}, LONG);

afterAll(async () => {
  await tearDownLinks(env);
}, LONG);

function admin(): Person {
  return people.admin;
}

/** A record labelled internal; controls belong to the Control Owner unless `owner` says otherwise. */
async function rec(kind: RecordKind, owner?: string): Promise<Rec> {
  const own = owner ?? (kind === 'control' ? people.control_owner.id : undefined);
  return makeRecord(env, admin(), kind, { label: 'internal', ...(own !== undefined ? { owner: own } : {}) });
}

describe('criterion 5: GET /api/v1/<plural>/:id/links, every role x kind', () => {
  const records = {} as Record<RecordKind, Rec>;
  let notOwnedControl: Rec;

  beforeAll(async () => {
    for (const kind of KINDS) records[kind] = await rec(kind);
    notOwnedControl = await rec('control', people.admin.id);
  }, LONG);

  const cases = ROLES.flatMap((role) => KINDS.map((kind) => [role, kind] as const));

  it.each(cases)(
    '%s on /%s/:id/links',
    async (role, kind) => {
      const cell = cellOf(TABLE, role, kind);
      const res = await getLinks(env, people[role], kind, records[kind].id);
      const want = cell === 'none' ? 403 : mayView(cell, true) ? 200 : 404;
      expect(answered(res), `${role} ${RECORD_PATHS[kind]} (cell ${cell}): ${show(res)}`).toBe(want);
    },
    T,
  );

  it.each(ROLES)(
    '%s on /controls/:id/links for a control owned by someone else',
    async (role) => {
      const cell = cellOf(TABLE, role, 'control');
      const res = await getLinks(env, people[role], 'control', notOwnedControl.id);
      const want = cell === 'none' ? 403 : mayView(cell, false) ? 200 : 404;
      expect(answered(res), `${role} (cell ${cell}): ${show(res)}`).toBe(want);
    },
    T,
  );
});

describe('criterion 5: GET /api/v1/assets/:id/map, every role', () => {
  let centre: Rec;

  beforeAll(async () => {
    centre = await rec('asset');
  }, LONG);

  it.each(ROLES)(
    '%s',
    async (role) => {
      const cell = cellOf(TABLE, role, 'asset');
      const res = await getMap(env, people[role], centre.id);
      expect(answered(res), `${role} (cell ${cell}): ${show(res)}`).toBe(mayView(cell, false) ? 200 : 403);
    },
    T,
  );
});

describe('criterion 5: POST /api/v1/links, every role x link type (D200)', () => {
  const cases = ROLES.flatMap((role) => LINK_TYPES.map((row) => [role, row.type, row.from, row.to] as const));

  it(`covers 7 roles x ${LINK_TYPES.length} link types`, () => {
    expect(cases).toHaveLength(7 * 7);
  });

  it.each(cases)(
    '%s: %s (%s -> %s)',
    async (role, type, fromKind, toKind) => {
      const from = await rec(fromKind);
      const to = await rec(toKind);
      // Controls here belong to the Control Owner.
      const fromCell = cellOf(TABLE, role, fromKind);
      const toCell = cellOf(TABLE, role, toKind);
      const owned = role === 'control_owner';
      const seeBoth = mayView(fromCell, owned) && mayView(toCell, owned);
      const editOne = mayEdit(fromCell, owned) || mayEdit(toCell, owned);
      const want = !seeBoth ? 404 : !editOne ? 403 : 201;
      const res = await postLink(env, people[role], { type, fromId: from.id, toId: to.id });
      expect(answered(res), `${role} ${type} (cells ${fromCell}/${toCell}): ${show(res)}`).toBe(want);
      expect(await storedLinks(env, orgId, from.id, to.id)).toHaveLength(want === 201 ? 1 : 0);
    },
    T,
  );

  it.each([
    ['MITIGATED_BY', 'risk', 'control'],
    ['GOVERNED_BY', 'control', 'policy'],
  ] as const)(
    'control_owner: %s with a control owned by someone else is 404',
    async (type, fromKind, toKind) => {
      const from = fromKind === 'control' ? await rec('control', people.admin.id) : await rec(fromKind);
      const to = toKind === 'control' ? await rec('control', people.admin.id) : await rec(toKind);
      const res = await postLink(env, people.control_owner, { type, fromId: from.id, toId: to.id });
      expect(answered(res), show(res)).toBe(404);
      expect(await storedLinks(env, orgId, from.id, to.id)).toHaveLength(0);
    },
    T,
  );
});

describe('the 7 routes are in the OpenAPI document', () => {
  const WANTED = [
    ['post', '/api/v1/links'],
    ...KINDS.map((kind) => ['get', `/api/v1/${RECORD_PATHS[kind]}/{id}/links`] as const),
    ['get', '/api/v1/assets/{id}/map'],
  ] as const;

  it.each(WANTED)(
    '%s %s',
    async (method, path) => {
      const res = await call(env.app, admin().signedIn.jar, { url: '/api/v1/openapi.json' });
      expect(res.statusCode, show(res)).toBe(200);
      const paths = (json(res)['paths'] ?? {}) as Record<string, Record<string, unknown>>;
      // Path parameters may be written {id} or :id.
      const normalised = new Map(Object.entries(paths).map(([p, v]) => [p.replace(/:([A-Za-z]+)/g, '{$1}'), v]));
      const entry = normalised.get(path);
      expect(entry, `${path} is documented`).toBeDefined();
      expect(Object.keys(entry ?? {}), `${method.toUpperCase()} ${path} is documented`).toContain(method);
    },
    T,
  );
});
