// M0-009 criterion 1 (D4, D55, D59, D73): with three orgs, for every ordered pair (A, B),
// grc_app in A's context sees none of B's rows in any org table, and can't insert, update
// or delete them.
//
// Each org holds rows in every org table: the Better Auth ones (organization, member,
// invitation) and the grant tables. The grant rows are chosen so they give nobody access:
// an expired auditor grant, a requested (unapproved) parent link, and an ended break-glass
// session. Later org tables are found from the catalog, so they are covered too.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  addUser,
  adminCtx,
  asApp,
  attempt,
  countFor,
  fingerprint,
  GRANT_TABLE_NAMES,
  insert,
  orgsSeen,
  orgTables,
  qualified,
  quoteIdent,
  rolledBack,
  Rollback,
  rows,
  seedOrg,
  setUpWall,
  table,
  tableName,
  tearDownWall,
  type OrgTable,
  type SeededOrg,
  type Wall,
} from './helpers.js';

let wall: Wall | undefined;
let orgs: SeededOrg[] = [];
let tables: OrgTable[] = [];

function w(): Wall {
  if (!wall) throw new Error('set-up did not finish');
  return wall;
}

beforeAll(async () => {
  wall = await setUpWall();
  const { sql } = wall.loaded;
  orgs = [await seedOrg(wall, 'Org A'), await seedOrg(wall, 'Org B'), await seedOrg(wall, 'Org C')];
  // Grant rows that grant nothing, one set per org, naming a user of the next org.
  for (let i = 0; i < orgs.length; i++) {
    const org = orgs[i]!;
    const next = orgs[(i + 1) % orgs.length]!;
    const outsider = await addUser(wall, `${next.name} auditor`);
    await addMember(wall, next.id, outsider, 'auditor');
    await insert(wall.sup, wall.grants.auditorGrants!, {
      id: randomUUID(),
      orgId: org.id,
      userId: outsider,
      expiresAt: sql`now() - interval '1 day'`,
      revokedAt: null,
    });
    await insert(wall.sup, wall.grants.parentLinks!, {
      id: randomUUID(),
      orgId: org.id,
      parentOrgId: next.id,
      status: 'requested',
    });
    await insert(wall.sup, wall.grants.breakGlassSessions!, {
      id: randomUUID(),
      orgId: org.id,
      userId: outsider,
      reason: 'seeded ended session',
      expiresAt: sql`now() - interval '1 day'`,
      endedAt: sql`now() - interval '1 day'`,
    });
  }
  tables = await orgTables(wall);
}, 180_000);

afterAll(async () => {
  await tearDownWall(wall);
});

const PAIRS: Array<[number, number]> = [
  [0, 1],
  [0, 2],
  [1, 0],
  [1, 2],
  [2, 0],
  [2, 1],
];
const pairName = ([a, b]: [number, number]): string => `${'ABC'[a]} → ${'ABC'[b]}`;

describe('the org tables', () => {
  it('include organization, member, invitation and the three grant tables', () => {
    const names = tables.map((t) => t.name);
    for (const key of ['organization', 'member', 'invitation'] as const) {
      expect(names).toContain(tableName(table(w().identity, key)).name);
    }
    for (const name of GRANT_TABLE_NAMES) expect(names).toContain(name);
  });

  it('every seeded org has rows in every seeded org table (the superuser sees them)', async () => {
    const seeded = tables.filter(
      (t) =>
        t.key === 'id' ||
        (GRANT_TABLE_NAMES as readonly string[]).includes(t.name) ||
        ['member', 'invitation'].map((k) => tableName(table(w().identity, k)).name).includes(t.name),
    );
    for (const t of seeded) {
      for (const org of orgs) {
        expect(await countFor(w(), w().sup, t, org.id), `${t.name} rows for ${org.name}`).toBeGreaterThan(0);
      }
    }
  });
});

describe.each(PAIRS.map(([a, b]) => ({ a, b, name: pairName([a, b]) })))('ordered pair $name', ({ a, b, name }) => {
  it(`${name}: app_visible_org is true for A and false for B`, async () => {
    const A = orgs[a]!;
    const B = orgs[b]!;
    const { sql } = w().loaded;
    const [r] = await asApp(w(), adminCtx(A), (tx) =>
      rows<{ own: boolean; other: boolean }>(
        tx,
        sql`SELECT app_visible_org(${A.id}::uuid) AS own, app_visible_org(${B.id}::uuid) AS other`,
      ),
    );
    expect(r).toEqual({ own: true, other: false });
  });

  it(`${name}: A's context sees A's own rows (control)`, async () => {
    const A = orgs[a]!;
    await asApp(w(), adminCtx(A), async (tx) => {
      const org = tables.find((t) => t.key === 'id')!;
      expect(await countFor(w(), tx, org, A.id)).toBe(1);
      const member = tables.find((t) => t.name === tableName(table(w().identity, 'member')).name)!;
      expect(await countFor(w(), tx, member, A.id)).toBeGreaterThanOrEqual(2);
    });
  });

  it(`${name}: A's context sees none of B's rows in any org table`, async () => {
    const A = orgs[a]!;
    const B = orgs[b]!;
    await asApp(w(), adminCtx(A), async (tx) => {
      for (const t of tables) {
        expect(await countFor(w(), tx, t, B.id), `${t.name}: B's rows`).toBe(0);
        const seen = await orgsSeen(w(), tx, t);
        expect(
          seen.every((o) => o === A.id),
          `${t.name}: only A's rows are visible`,
        ).toBe(true);
      }
    });
  });

  it(`${name}: A's context can't update B's rows in any org table`, async () => {
    const A = orgs[a]!;
    const B = orgs[b]!;
    const { sql } = w().loaded;
    const before = await fingerprint(w());
    for (const t of tables) {
      const key = quoteIdent(t.key);
      await attempt(() =>
        asApp(w(), adminCtx(A), (tx) =>
          rows(
            tx,
            sql`UPDATE ${sql.raw(qualified(t))} SET ${sql.raw(key)} = ${sql.raw(key)} WHERE ${sql.raw(key)} = ${B.id}::uuid RETURNING 1`,
          ),
        ),
      );
    }
    expect(await fingerprint(w())).toEqual(before);
  });

  it(`${name}: A's context can't move its own rows into B`, async () => {
    const A = orgs[a]!;
    const B = orgs[b]!;
    const { sql } = w().loaded;
    const before = await fingerprint(w());
    for (const t of tables.filter((x) => x.key === 'org_id')) {
      await attempt(() =>
        asApp(w(), adminCtx(A), (tx) =>
          rows(
            tx,
            sql`UPDATE ${sql.raw(qualified(t))} SET org_id = ${B.id}::uuid WHERE org_id = ${A.id}::uuid RETURNING 1`,
          ),
        ),
      );
    }
    expect(await fingerprint(w())).toEqual(before);
  });

  it(`${name}: A's context can't delete B's rows in any org table`, async () => {
    const A = orgs[a]!;
    const B = orgs[b]!;
    const { sql } = w().loaded;
    const before = await fingerprint(w());
    for (const t of tables) {
      await attempt(() =>
        asApp(w(), adminCtx(A), (tx) =>
          rows(
            tx,
            sql`DELETE FROM ${sql.raw(qualified(t))} WHERE ${sql.raw(quoteIdent(t.key))} = ${B.id}::uuid RETURNING 1`,
          ),
        ),
      );
    }
    expect(await fingerprint(w())).toEqual(before);
  });

  it(`${name}: A's context can't insert rows for B into member, invitation or the grant tables`, async () => {
    const A = orgs[a]!;
    const B = orgs[b]!;
    const { sql } = w().loaded;
    const before = await fingerprint(w());
    const inserts: Array<[string, (org: string) => Promise<void>]> = [
      [
        'member',
        async (org) => {
          const u = await addUser(w(), 'insert probe');
          await asApp(w(), adminCtx(A), (tx) =>
            (tx as unknown as Wall['app']).insert(table(w().identity, 'member')).values({
              id: randomUUID(),
              organizationId: org,
              userId: u,
              role: 'viewer',
              createdAt: new Date(),
            } as never),
          );
        },
      ],
      [
        'invitation',
        (org) =>
          asApp(w(), adminCtx(A), (tx) =>
            (tx as unknown as Wall['app']).insert(table(w().identity, 'invitation')).values({
              id: randomUUID(),
              organizationId: org,
              email: `probe.${randomUUID().slice(0, 8)}@org-wall.test`,
              role: 'viewer',
              status: 'pending',
              expiresAt: new Date(Date.now() + 86_400_000),
              inviterId: A.adminId,
              createdAt: new Date(),
            } as never),
          ).then(() => undefined),
      ],
      [
        'auditor_grants',
        (org) =>
          asApp(w(), adminCtx(A), (tx) =>
            (tx as unknown as Wall['app']).insert(w().grants.auditorGrants!).values({
              id: randomUUID(),
              orgId: org,
              userId: A.adminId,
              expiresAt: sql`now() + interval '30 days'`,
              revokedAt: null,
            } as never),
          ).then(() => undefined),
      ],
      [
        'parent_links',
        (org) =>
          asApp(w(), adminCtx(A), (tx) =>
            (tx as unknown as Wall['app']).insert(w().grants.parentLinks!).values({
              id: randomUUID(),
              orgId: org,
              parentOrgId: A.id,
              status: 'approved',
            } as never),
          ).then(() => undefined),
      ],
      [
        'break_glass_sessions',
        (org) =>
          asApp(w(), adminCtx(A), (tx) =>
            (tx as unknown as Wall['app']).insert(w().grants.breakGlassSessions!).values({
              id: randomUUID(),
              orgId: org,
              userId: A.adminId,
              reason: 'probe',
              expiresAt: sql`now() + interval '30 minutes'`,
              endedAt: null,
            } as never),
          ).then(() => undefined),
      ],
    ];
    for (const [label, run] of inserts) {
      await attempt(() => run(B.id));
      const after = await fingerprint(w());
      const changed = Object.keys(after).filter((k) => k.endsWith(`.${label}`) && after[k] !== before[k]);
      expect(changed, `${label}: a row for B was inserted from A's context`).toEqual([]);
    }
  });

  it(`${name}: A's context can insert its own member row (control for the insert check)`, async () => {
    const A = orgs[a]!;
    const u = await addUser(w(), 'own insert probe');
    await rolledBack(() =>
      asApp(w(), adminCtx(A), async (tx) => {
        await (tx as unknown as Wall['app']).insert(table(w().identity, 'member')).values({
          id: randomUUID(),
          organizationId: A.id,
          userId: u,
          role: 'viewer',
          createdAt: new Date(),
        } as never);
        throw new Rollback();
      }),
    );
  });
});
