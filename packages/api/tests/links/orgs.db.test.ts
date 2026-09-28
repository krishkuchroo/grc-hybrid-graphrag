// S1-005 criterion 5, every org pair (D59, D55): with 3 orgs, for each ordered pair (A, B), A's
// Admin (every type, clearance restricted) can't link to, list or map B's records, even with the
// right IDs: 404 on every route, the same as a made-up ID, and nothing is written in either org.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KINDS,
  LONG,
  T,
  getLinks,
  getMap,
  linkDirect,
  linkItems,
  mapBody,
  makeRecord,
  newLinksOrg,
  outboxEntries,
  person,
  postLink,
  refusal,
  relationshipCount,
  setUpLinks,
  tearDownLinks,
  type LinksEnv,
  type Person,
  type Rec,
  type RecordKind,
} from './helpers.js';

interface OrgSet {
  name: string;
  orgId: string;
  admin: Person;
  records: Record<RecordKind, Rec>;
  otherAsset: Rec;
}

let env: LinksEnv;
const orgs: OrgSet[] = [];

beforeAll(async () => {
  env = await setUpLinks();
  for (const name of ['A', 'B', 'C']) {
    const org = await newLinksOrg(env, `Links Org ${name}`);
    const admin = await person(env, org, 'admin', 'restricted');
    const records = {} as Record<RecordKind, Rec>;
    for (const kind of KINDS) records[kind] = await makeRecord(env, admin, kind, { label: 'public' });
    const otherAsset = await makeRecord(env, admin, 'asset', { label: 'public' });
    // Each org has links of its own, so an empty answer can't pass by accident.
    for (const [type, from, to] of [
      ['MITIGATED_BY', records.risk, records.control],
      ['HOSTS', records.asset, otherAsset],
    ] as const) {
      // Written straight into the org database, so the set-up never depends on POST /api/v1/links.
      await linkDirect(env, org.id, type, from.id, to.id, admin.id);
    }
    orgs.push({ name, orgId: org.id, admin, records, otherAsset });
  }
}, LONG);

afterAll(async () => {
  await tearDownLinks(env);
}, LONG);

const PAIRS = [0, 1, 2].flatMap((a) => [0, 1, 2].filter((b) => b !== a).map((b) => [a, b] as const));
const GHOST = '00000000-0000-4000-8000-0000000000c1';

describe('criterion 5: each org sees its own links', () => {
  it.each([0, 1, 2])(
    'org %i lists and maps its own',
    async (i) => {
      const o = orgs[i]!;
      expect(linkItems(await getLinks(env, o.admin, 'risk', o.records.risk.id)).map((x) => x.other.id)).toEqual([
        o.records.control.id,
      ]);
      expect(mapBody(await getMap(env, o.admin, o.records.asset.id)).nodes).toHaveLength(2);
    },
    T,
  );
});

describe.each(PAIRS.map(([a, b]) => [`${'ABC'[a]} -> ${'ABC'[b]}`, a, b] as const))(
  'criterion 5: org pair %s',
  (_label, a, b) => {
    it(
      "A's Admin gets 404 listing the links of each of B's records, the same as a made-up ID",
      async () => {
        const A = orgs[a]!;
        const B = orgs[b]!;
        for (const kind of KINDS) {
          const ghost = refusal(await getLinks(env, A.admin, kind, GHOST), 404);
          const res = await getLinks(env, A.admin, kind, B.records[kind].id);
          expect(refusal(res, 404), `${kind}`).toEqual(ghost);
          expect(res.body).not.toContain(B.records.control.id);
        }
      },
      T,
    );

    it(
      "A's Admin gets 404 mapping B's asset",
      async () => {
        const A = orgs[a]!;
        const B = orgs[b]!;
        const ghost = refusal(await getMap(env, A.admin, GHOST), 404);
        const res = await getMap(env, A.admin, B.records.asset.id);
        expect(refusal(res, 404)).toEqual(ghost);
        expect(res.body).not.toContain(B.otherAsset.id);
      },
      T,
    );

    it(
      "A's Admin can't link to B's records: 404 for either end or both, nothing written anywhere",
      async () => {
        const A = orgs[a]!;
        const B = orgs[b]!;
        const counts = async () =>
          Promise.all(
            orgs.map(async (o) => [await relationshipCount(env, o.orgId), (await outboxEntries(env, o.orgId)).length]),
          );
        const before = await counts();
        const attempts = [
          { type: 'MITIGATED_BY', fromId: A.records.risk.id, toId: B.records.control.id },
          { type: 'MITIGATED_BY', fromId: B.records.risk.id, toId: A.records.control.id },
          { type: 'GOVERNED_BY', fromId: B.records.control.id, toId: B.records.policy.id },
          { type: 'HOSTS', fromId: A.records.asset.id, toId: B.records.asset.id },
          { type: 'IMPACTS', fromId: B.records.incident.id, toId: B.records.asset.id },
        ];
        for (const body of attempts) {
          const r = refusal(await postLink(env, A.admin, body), 404);
          expect(r.code, JSON.stringify(body)).toBe('not_found');
        }
        expect(await counts()).toEqual(before);
      },
      T,
    );
  },
);
