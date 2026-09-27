// M0-009 criterion 2 (D73, fail safe): with no `app.org_id` set, every org table returns
// zero rows, without an error and never all rows.
// Covered: a query outside any transaction, a transaction with no settings, the pooled
// connection after a withOrgContext call (where `app.org_id` reads back as ''), an explicit
// empty `app.org_id`, and a user id that holds an active auditor grant but no org id.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  addUser,
  adminCtx,
  countFor,
  fingerprint,
  insert,
  orgTables,
  qualified,
  rows,
  seedOrg,
  setUpWall,
  table,
  tearDownWall,
  type Db,
  type OrgTable,
  type SeededOrg,
  type Wall,
} from './helpers.js';
import { appUrl, closeDb } from '../db/helpers.js';

let wall: Wall | undefined;
let one: Db | undefined; // a grc_app pool with exactly one connection
let orgs: SeededOrg[] = [];
let tables: OrgTable[] = [];
let grantedAuditor = '';

function w(): Wall {
  if (!wall) throw new Error('set-up did not finish');
  return wall;
}

beforeAll(async () => {
  wall = await setUpWall();
  const { sql } = wall.loaded;
  orgs = [await seedOrg(wall, 'Org A'), await seedOrg(wall, 'Org B'), await seedOrg(wall, 'Org C')];
  grantedAuditor = await addUser(wall, 'Org A auditor');
  await addMember(wall, orgs[0]!.id, grantedAuditor, 'auditor');
  await insert(wall.sup, wall.grants.auditorGrants!, {
    id: randomUUID(),
    orgId: orgs[1]!.id,
    userId: grantedAuditor,
    expiresAt: sql`now() + interval '30 days'`,
    revokedAt: null,
  });
  tables = await orgTables(wall);
  one = wall.loaded.createDb(appUrl(wall.dbName), { max: 1 });
}, 180_000);

afterAll(async () => {
  await closeDb(one);
  await tearDownWall(wall);
});

function pool(): Db {
  if (!one) throw new Error('set-up did not finish');
  return one;
}

async function totalCount(db: { execute: (q: never) => Promise<unknown> }, t: OrgTable): Promise<number> {
  const { sql } = w().loaded;
  const [r] = await rows<{ n: string | number }>(db, sql`SELECT count(*) AS n FROM ${sql.raw(qualified(t))}`);
  return Number(r!.n);
}

async function expectAllEmpty(db: { execute: (q: never) => Promise<unknown> }, how: string): Promise<void> {
  expect(tables.length).toBeGreaterThanOrEqual(6);
  for (const t of tables) {
    expect(await totalCount(db, t), `${how}: ${t.name}`).toBe(0);
  }
}

describe('no org context (criterion 2)', () => {
  it('the seeded rows are there for the superuser (control)', async () => {
    for (const t of tables.filter((x) => x.key === 'id' || x.name === 'member')) {
      for (const org of orgs) expect(await countFor(w(), w().sup, t, org.id)).toBeGreaterThan(0);
    }
  });

  it('a query outside any transaction sees zero rows in every org table', async () => {
    await expectAllEmpty(pool(), 'no transaction');
  });

  it('a transaction with no settings sees zero rows in every org table', async () => {
    await pool().transaction(async (tx) => {
      await expectAllEmpty(tx as never, 'empty transaction');
    });
  });

  it('after a withOrgContext call, the same pooled connection sees zero rows', async () => {
    const { sql } = w().loaded;
    const seen = await w().loaded.withOrgContext(pool(), adminCtx(orgs[0]!), (tx) =>
      rows<{ n: string | number }>(tx, sql`SELECT count(*) AS n FROM ${sql.raw(qualified(tables[0]!))}`),
    );
    expect(Number(seen[0]!.n)).toBe(1); // control: inside the context, A's organization row
    const [setting] = await rows<{ v: string | null }>(pool(), sql`SELECT current_setting('app.org_id', true) AS v`);
    expect(setting!.v ?? '').toBe('');
    await expectAllEmpty(pool(), 'after withOrgContext');
  });

  it("app.org_id set to '' sees zero rows", async () => {
    const { sql } = w().loaded;
    await pool().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.org_id', '', true)`);
      await expectAllEmpty(tx as never, "app.org_id = ''");
    });
  });

  it('a user id holding an active auditor grant, with no org id, sees zero rows', async () => {
    const { sql } = w().loaded;
    await pool().transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.user_id', ${grantedAuditor}, true),
                                  set_config('app.role', 'auditor', true),
                                  set_config('app.clearance', 'internal', true)`);
      await expectAllEmpty(tx as never, 'user id only');
    });
  });

  it('app_visible_org is false for every org with no org context', async () => {
    const { sql } = w().loaded;
    for (const org of orgs) {
      const [r] = await rows<{ v: boolean | null }>(pool(), sql`SELECT app_visible_org(${org.id}::uuid) AS v`);
      expect(r!.v === true, `app_visible_org(${org.name})`).toBe(false);
    }
  });

  it('a write with no org context changes nothing', async () => {
    const before = await fingerprint(w());
    const u = await addUser(w(), 'no-context probe');
    try {
      await pool()
        .insert(table(w().identity, 'member'))
        .values({
          id: randomUUID(),
          organizationId: orgs[0]!.id,
          userId: u,
          role: 'viewer',
          createdAt: new Date(),
        } as never);
    } catch {
      // refused: fine
    }
    expect(await fingerprint(w())).toEqual(before);
  });
});
