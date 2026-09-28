// M0-009 criterion 6 (D57, D73): grc_app can't `ALTER TABLE … DISABLE ROW LEVEL SECURITY`,
// and can't `SET row_security = off` to get around it. Also covered: NO FORCE, dropping,
// adding or changing policies, replacing app_visible_org, and switching to another role.
// Each refused statement must fail on rights ("must be owner", "permission denied"), not
// on a wrong name, so a typo can't make a check pass.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminCtx,
  asApp,
  errorText,
  failure,
  orgTables,
  qualified,
  quoteIdent,
  rows,
  seedOrg,
  setUpWall,
  tearDownWall,
  type OrgTable,
  type SeededOrg,
  type Wall,
} from './helpers.js';

let wall: Wall | undefined;
let A: SeededOrg;
let B: SeededOrg;
let tables: OrgTable[] = [];

function w(): Wall {
  if (!wall) throw new Error('set-up did not finish');
  return wall;
}

beforeAll(async () => {
  wall = await setUpWall();
  A = await seedOrg(wall, 'Org A');
  B = await seedOrg(wall, 'Org B');
  tables = await orgTables(wall);
}, 180_000);

afterAll(async () => {
  await tearDownWall(wall);
});

const REFUSED = /must be owner|permission denied/i;

async function flags(t: OrgTable): Promise<{ rls: boolean; forced: boolean }> {
  const { sql } = w().loaded;
  const [r] = await rows<{ rls: boolean; forced: boolean }>(
    w().sup,
    sql`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = ${t.schema} AND c.relname = ${t.name}`,
  );
  return r!;
}

async function policies(t: OrgTable): Promise<string[]> {
  const { sql } = w().loaded;
  const found = await rows<{ p: string }>(
    w().sup,
    sql`SELECT policyname || ':' || cmd || ':' || coalesce(qual, '') || ':' || coalesce(with_check, '') AS p
        FROM pg_policies WHERE schemaname = ${t.schema} AND tablename = ${t.name} ORDER BY 1`,
  );
  return found.map((f) => f.p);
}

async function refused(statement: string): Promise<void> {
  const { sql } = w().loaded;
  const text = await failure(() => asApp(w(), adminCtx(A), (tx) => rows(tx, sql.raw(statement))));
  expect(text, statement).toMatch(REFUSED);
}

describe('grc_app cannot switch RLS off (criterion 6)', () => {
  it('there are org tables to check', () => {
    expect(tables.length).toBeGreaterThanOrEqual(6);
  });

  it('ALTER TABLE … DISABLE ROW LEVEL SECURITY is refused on every org table, and RLS stays on', async () => {
    for (const t of tables) {
      await refused(`ALTER TABLE ${qualified(t)} DISABLE ROW LEVEL SECURITY`);
      expect(await flags(t), t.name).toEqual({ rls: true, forced: true });
    }
  });

  it('ALTER TABLE … NO FORCE ROW LEVEL SECURITY is refused on every org table, and FORCE stays on', async () => {
    for (const t of tables) {
      await refused(`ALTER TABLE ${qualified(t)} NO FORCE ROW LEVEL SECURITY`);
      expect(await flags(t), t.name).toEqual({ rls: true, forced: true });
    }
  });

  it('dropping or changing a policy is refused, and the policies stay the same', async () => {
    for (const t of tables) {
      const before = await policies(t);
      expect(before.length, `${t.name} has policies`).toBeGreaterThan(0);
      for (const p of before) {
        const name = p.split(':')[0]!;
        await refused(`DROP POLICY ${quoteIdent(name)} ON ${qualified(t)}`);
        await refused(`ALTER POLICY ${quoteIdent(name)} ON ${qualified(t)} USING (true)`);
      }
      await refused(`CREATE POLICY wide_open ON ${qualified(t)} FOR ALL USING (true) WITH CHECK (true)`);
      expect(await policies(t)).toEqual(before);
    }
  });

  it('replacing app_visible_org is refused', async () => {
    await refused(
      `CREATE OR REPLACE FUNCTION app_visible_org(org uuid) RETURNS boolean LANGUAGE sql AS $$ SELECT true $$`,
    );
    const { sql } = w().loaded;
    const [r] = await asApp(w(), adminCtx(A), (tx) =>
      rows<{ v: boolean }>(tx, sql`SELECT app_visible_org(${B.id}::uuid) AS v`),
    );
    expect(r!.v).toBe(false);
  });

  it('SET ROLE to the migration account or the superuser is refused', async () => {
    const { sql } = w().loaded;
    for (const role of ['grc_migrator', 'postgres']) {
      const text = await failure(() => asApp(w(), adminCtx(A), (tx) => rows(tx, sql.raw(`SET LOCAL ROLE ${role}`))));
      expect(text, role).toMatch(/permission denied|must be member|not permitted/i);
    }
  });
});

describe('SET row_security = off does not get around RLS (criterion 6)', () => {
  // With row_security off, Postgres must either refuse the query ("query would be affected
  // by row-level security policy") or still apply the policies. It must never return B's rows.
  it("in A's context, no org table returns B's rows", async () => {
    const { sql } = w().loaded;
    for (const t of tables) {
      let seen: number | 'refused';
      try {
        const [r] = await asApp(w(), adminCtx(A), async (tx) => {
          await rows(tx, sql`SET LOCAL row_security = off`);
          return rows<{ n: string | number }>(
            tx,
            sql`SELECT count(*) AS n FROM ${sql.raw(qualified(t))} WHERE ${sql.raw(quoteIdent(t.key))} = ${B.id}::uuid`,
          );
        });
        seen = Number(r!.n);
      } catch (err) {
        expect(errorText(err)).toMatch(/row-level security|permission denied/i);
        seen = 'refused';
      }
      expect([0, 'refused'], t.name).toContain(seen);
    }
  });

  it('with no org context, no org table returns any rows', async () => {
    const { sql } = w().loaded;
    for (const t of tables) {
      let seen: number | 'refused';
      try {
        const [r] = await w().app.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL row_security = off`);
          return rows<{ n: string | number }>(tx as never, sql`SELECT count(*) AS n FROM ${sql.raw(qualified(t))}`);
        });
        seen = Number(r!.n);
      } catch (err) {
        expect(errorText(err)).toMatch(/row-level security|permission denied/i);
        seen = 'refused';
      }
      expect([0, 'refused'], t.name).toContain(seen);
    }
  });
});
