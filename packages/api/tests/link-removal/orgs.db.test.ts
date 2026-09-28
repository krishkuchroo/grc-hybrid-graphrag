// S1-011 criterion 8, every org pair (D59, D55, D54): with 3 orgs, for each ordered pair (A, B),
// A's Admin (every type, clearance restricted) and A's Admin API key can't remove B's link, even with
// the right IDs: 404, the same answer as a made-up ID, and B's link and B's audit entries are
// untouched (nothing is written in any org).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GHOST,
  LONG,
  T,
  body,
  createKey,
  linkCount,
  makeRecord,
  newLinksOrg,
  outboxEntries,
  person,
  refusal,
  relationshipCount,
  removeLink,
  removeWithKey,
  removed,
  seedLink,
  setUpRemoval,
  tearDownRemoval,
  type NewKey,
  type Person,
  type Rec,
  type RemovalEnv,
} from './helpers.js';

interface OrgSet {
  orgId: string;
  admin: Person;
  key: NewKey;
  risk: Rec;
  control: Rec;
  a1: Rec;
  a2: Rec;
}

let env: RemovalEnv;
const orgs: OrgSet[] = [];

beforeAll(async () => {
  env = await setUpRemoval();
  for (const name of ['A', 'B', 'C']) {
    const org = await newLinksOrg(env, `Link Removal Org ${name}`);
    const admin = await person(env, org, 'admin', 'restricted');
    const key = await createKey(env.app, admin.signedIn, { role: 'admin', name: `org ${name} admin key` });
    const risk = await makeRecord(env, admin, 'risk', { label: 'public' });
    const control = await makeRecord(env, admin, 'control', { label: 'public' });
    const a1 = await makeRecord(env, admin, 'asset', { label: 'public' });
    const a2 = await makeRecord(env, admin, 'asset', { label: 'public' });
    await seedLink(env, org.id, 'MITIGATED_BY', risk, control, { createdBy: admin.id });
    await seedLink(env, org.id, 'HOSTS', a1, a2, { createdBy: admin.id });
    orgs.push({ orgId: org.id, admin, key, risk, control, a1, a2 });
  }
}, LONG);

afterAll(async () => {
  await tearDownRemoval(env);
}, LONG);

const PAIRS = [0, 1, 2].flatMap((a) => [0, 1, 2].filter((b) => b !== a).map((b) => [a, b] as const));

async function counts(): Promise<number[][]> {
  return Promise.all(
    orgs.map(async (o) => [await relationshipCount(env, o.orgId), (await outboxEntries(env, o.orgId)).length]),
  );
}

describe.each(PAIRS.map(([a, b]) => [`${'ABC'[a]} -> ${'ABC'[b]}`, a, b] as const))(
  'criterion 8: org pair %s',
  (_label, a, b) => {
    it(
      "A's Admin can't remove B's links: 404 like a made-up ID, nothing changes in any org",
      async () => {
        const A = orgs[a]!;
        const B = orgs[b]!;
        const before = await counts();
        const ghost = refusal(
          await removeLink(env, A.admin, { type: 'MITIGATED_BY', fromId: GHOST, toId: GHOST }),
          404,
        );
        for (const attempt of [body('MITIGATED_BY', B.risk, B.control), body('HOSTS', B.a1, B.a2)]) {
          const res = await removeLink(env, A.admin, attempt);
          expect(refusal(res, 404), JSON.stringify(attempt)).toEqual(ghost);
          expect(res.body).not.toContain(B.risk.number);
        }
        // Mixed ends: one of A's records and one of B's.
        refusal(await removeLink(env, A.admin, body('MITIGATED_BY', A.risk, B.control)), 404);
        refusal(await removeLink(env, A.admin, body('HOSTS', A.a1, B.a2)), 404);
        expect(await linkCount(env, B.orgId, 'MITIGATED_BY', B.risk.id, B.control.id)).toBe(1);
        expect(await linkCount(env, B.orgId, 'HOSTS', B.a1.id, B.a2.id)).toBe(1);
        expect(await counts()).toEqual(before);
      },
      T,
    );

    it(
      "A's Admin API key can't remove B's links: 404, nothing changes in any org",
      async () => {
        const A = orgs[a]!;
        const B = orgs[b]!;
        const before = await counts();
        for (const attempt of [body('MITIGATED_BY', B.risk, B.control), body('HOSTS', B.a1, B.a2)]) {
          expect(refusal(await removeWithKey(env, A.key, attempt), 404).code).toBe('not_found');
        }
        expect(await counts()).toEqual(before);
      },
      T,
    );
  },
);

describe('criterion 8: each org removes its own link', () => {
  it.each([0, 1, 2])(
    'org %i',
    async (i) => {
      const o = orgs[i]!;
      const x = await makeRecord(env, o.admin, 'asset', { label: 'public' });
      const y = await makeRecord(env, o.admin, 'asset', { label: 'public' });
      await seedLink(env, o.orgId, 'RUNS', x, y);
      const others = await Promise.all(
        orgs
          .filter((_, j) => j !== i)
          .map(async (p) => [await relationshipCount(env, p.orgId), (await outboxEntries(env, p.orgId)).length]),
      );
      removed(await removeLink(env, o.admin, body('RUNS', x, y)), body('RUNS', x, y));
      expect(await linkCount(env, o.orgId, 'RUNS', x.id, y.id)).toBe(0);
      const after = await Promise.all(
        orgs
          .filter((_, j) => j !== i)
          .map(async (p) => [await relationshipCount(env, p.orgId), (await outboxEntries(env, p.orgId)).length]),
      );
      expect(after).toEqual(others);
    },
    T,
  );
});
