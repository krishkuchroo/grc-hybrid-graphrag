// S1-011 criteria 1 and 8, every role cell (D59, D50, D200, D201, D54): each role, as a person and
// as an API key, against POST /api/v1/links/remove for every pair of record kinds the ontology
// allows (LINK_TYPES), on manual links. The expected answer is worked out from the ROLE_TABLE cells
// (not through `can` or `canLinkRecords`): 404 when the caller can't see an end, else 403 when they
// can edit neither end, else 200 and the link is gone.
// Everyone here has clearance restricted (a key has internal, M0-011) and every record is labelled
// internal, so only the role decides; clearance x label is clearance.db.test.ts. Controls belong to
// the Control Owner person; a key owns nothing, so for a Control Owner key they are "not own".
// Also: the route is in the OpenAPI document, with its 409 `ai_link_review_only` answer.
import { ROLE_TABLE } from '@grc/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call } from '../auth/helpers.js';
import {
  LINK_ROWS,
  LONG,
  ROLES,
  T,
  answered,
  body,
  cellOf,
  createKey,
  json,
  linkCount,
  makeRecord,
  mayEdit,
  mayView,
  newLinksOrg,
  outboxEntries,
  person,
  removeLink,
  removeWithKey,
  seedLink,
  setUpRemoval,
  show,
  targetIdOf,
  tearDownRemoval,
  type NewKey,
  type Person,
  type Rec,
  type RecordKind,
  type RemovalEnv,
  type Role,
} from './helpers.js';

const TABLE = ROLE_TABLE as unknown as Record<string, Record<string, string>>;

let env: RemovalEnv;
let orgId: string;
const people = {} as Record<Role, Person>;
const keys = {} as Record<Role, NewKey>;

beforeAll(async () => {
  env = await setUpRemoval();
  const org = await newLinksOrg(env, 'Link Removal Roles');
  orgId = org.id;
  for (const role of ROLES) people[role] = await person(env, org, role, 'restricted');
  for (const role of ROLES) keys[role] = await createKey(env.app, people.admin.signedIn, { role, name: `${role} key` });
}, LONG);

afterAll(async () => {
  await tearDownRemoval(env);
}, LONG);

async function rec(kind: RecordKind, owner?: string): Promise<Rec> {
  const own = owner ?? (kind === 'control' ? people.control_owner.id : undefined);
  return makeRecord(env, people.admin, kind, { label: 'internal', ...(own !== undefined ? { owner: own } : {}) });
}

function expected(role: Role, fromKind: RecordKind, toKind: RecordKind, owned: boolean): 200 | 403 | 404 {
  const fromCell = cellOf(TABLE, role, fromKind);
  const toCell = cellOf(TABLE, role, toKind);
  if (!(mayView(fromCell, owned) && mayView(toCell, owned))) return 404;
  if (!(mayEdit(fromCell, owned) || mayEdit(toCell, owned))) return 403;
  return 200;
}

describe('criterion 8: every role x link type, a person (D200, D201)', () => {
  const cases = ROLES.flatMap((role) => LINK_ROWS.map((row) => [role, row.type, row.from, row.to] as const));

  it(`covers 7 roles x ${LINK_ROWS.length} link types`, () => {
    expect(cases).toHaveLength(7 * LINK_ROWS.length);
  });

  it.each(cases)(
    '%s: %s (%s -> %s)',
    async (role, type, fromKind, toKind) => {
      const from = await rec(fromKind);
      const to = await rec(toKind);
      await seedLink(env, orgId, type, from, to, { createdBy: people.admin.id });
      const want = expected(role, fromKind, toKind, role === 'control_owner');
      const res = await removeLink(env, people[role], body(type, from, to));
      expect(answered(res), `${role} ${type}: ${show(res)}`).toBe(want);
      if (want !== 200) {
        expect((json(res) as { error?: { code?: string } }).error?.code).toBe(want === 404 ? 'not_found' : 'forbidden');
      }
      expect(await linkCount(env, orgId, type, from.id, to.id)).toBe(want === 200 ? 0 : 1);
      const key = await targetIdOf(type, from.id, to.id);
      const entries = (await outboxEntries(env, orgId, 'link.removed')).filter((e) => e.targetId === key);
      expect(entries).toHaveLength(want === 200 ? 1 : 0);
      if (want === 200) expect(entries[0]).toMatchObject({ actorType: 'user', actorId: people[role].id });
    },
    T,
  );

  it.each([
    ['MITIGATED_BY', 'risk', 'control'],
    ['GOVERNED_BY', 'control', 'policy'],
  ] as const)(
    'control_owner: %s through a control owned by someone else is 404, the link stays',
    async (type, fromKind, toKind) => {
      const from = fromKind === 'control' ? await rec('control', people.admin.id) : await rec(fromKind);
      const to = toKind === 'control' ? await rec('control', people.admin.id) : await rec(toKind);
      await seedLink(env, orgId, type, from, to);
      const res = await removeLink(env, people.control_owner, body(type, from, to));
      expect(answered(res), show(res)).toBe(404);
      expect(await linkCount(env, orgId, type, from.id, to.id)).toBe(1);
    },
    T,
  );
});

describe('criterion 8: every role x link type, an API key (its one role, clearance internal, owns nothing)', () => {
  const cases = ROLES.flatMap((role) => LINK_ROWS.map((row) => [role, row.type, row.from, row.to] as const));

  it.each(cases)(
    '%s key: %s (%s -> %s)',
    async (role, type, fromKind, toKind) => {
      const from = await rec(fromKind);
      const to = await rec(toKind);
      await seedLink(env, orgId, type, from, to);
      const want = expected(role, fromKind, toKind, false);
      const res = await removeWithKey(env, keys[role], body(type, from, to));
      expect(answered(res), `${role} key ${type}: ${show(res)}`).toBe(want);
      expect(await linkCount(env, orgId, type, from.id, to.id)).toBe(want === 200 ? 0 : 1);
      const key = await targetIdOf(type, from.id, to.id);
      const entries = (await outboxEntries(env, orgId, 'link.removed')).filter((e) => e.targetId === key);
      expect(entries).toHaveLength(want === 200 ? 1 : 0);
      if (want === 200) expect(entries[0]).toMatchObject({ actorType: 'api_key', actorId: keys[role].id });
    },
    T,
  );

  it(
    'a key with clearance internal gets 404 on a link to a confidential record, the link stays',
    async () => {
      const risk = await rec('risk');
      const control = await makeRecord(env, people.admin, 'control', { label: 'confidential' });
      await seedLink(env, orgId, 'MITIGATED_BY', risk, control);
      const res = await removeWithKey(env, keys.admin, body('MITIGATED_BY', risk, control));
      expect(answered(res), show(res)).toBe(404);
      expect(await linkCount(env, orgId, 'MITIGATED_BY', risk.id, control.id)).toBe(1);
    },
    T,
  );
});

describe('the route is in the OpenAPI document', () => {
  it(
    'POST /api/v1/links/remove, with its 409 ai_link_review_only answer',
    async () => {
      const res = await call(env.app, people.admin.signedIn.jar, { url: '/api/v1/openapi.json' });
      expect(res.statusCode, show(res)).toBe(200);
      const paths = (json(res)['paths'] ?? {}) as Record<string, Record<string, unknown>>;
      const entry = paths['/api/v1/links/remove'];
      expect(entry, '/api/v1/links/remove is documented').toBeDefined();
      const op = entry?.['post'];
      expect(op, 'POST /api/v1/links/remove is documented').toBeDefined();
      expect(JSON.stringify(op), 'the 409 ai_link_review_only answer is documented').toContain('ai_link_review_only');
    },
    T,
  );
});
