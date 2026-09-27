// M0-009 criterion 5 (D73): every table with an `org_id` column has RLS enabled and forced,
// checked from pg_class across the schema, so tables added by later tasks are caught too.
// Also the rule for org tables from the brief (`org_id uuid not null`, the standard policy),
// and the table shapes the brief's Files section names (Better Auth tables, member role and
// clearance, the three grant tables).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addUser,
  BETTER_AUTH_TABLES,
  GRANT_TABLE_NAMES,
  GRANT_TABLES,
  insert,
  LABELS,
  ROLES,
  rows,
  seedOrg,
  setUpWall,
  table,
  tableName,
  tearDownWall,
  type SeededOrg,
  type Wall,
} from './helpers.js';

let wall: Wall | undefined;
let org: SeededOrg;

function w(): Wall {
  if (!wall) throw new Error('set-up did not finish');
  return wall;
}

beforeAll(async () => {
  wall = await setUpWall();
  org = await seedOrg(wall, 'Org A');
}, 180_000);

afterAll(async () => {
  await tearDownWall(wall);
});

interface Rel {
  schema: string;
  name: string;
  kind: string;
  rls: boolean;
  forced: boolean;
  type: string;
  notnull: boolean;
}

// Every table (ordinary, partitioned, or a partition) outside the system schemas that has
// an org_id column, with its RLS flags and the column's type.
async function tablesWithOrgId(): Promise<Rel[]> {
  const { sql } = w().loaded;
  return rows<Rel>(
    w().sup,
    sql`SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind,
               c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
               format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull AS notnull
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'org_id' AND NOT a.attisdropped
        WHERE c.relkind IN ('r', 'p')
          AND n.nspname NOT IN ('pg_catalog', 'information_schema')
          AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%'
        ORDER BY 1, 2`,
  );
}

describe('RLS is enabled and forced on every org table (criterion 5)', () => {
  it('member, invitation and the three grant tables have an org_id column', async () => {
    const names = (await tablesWithOrgId()).map((r) => r.name);
    for (const key of ['member', 'invitation'] as const) {
      expect(names).toContain(tableName(table(w().identity, key)).name);
    }
    for (const name of GRANT_TABLE_NAMES) expect(names).toContain(name);
  });

  it('every table with an org_id column has RLS enabled and forced', async () => {
    const found = await tablesWithOrgId();
    expect(found.length).toBeGreaterThanOrEqual(5);
    const bad = found.filter((r) => !r.rls || !r.forced).map((r) => `${r.schema}.${r.name}`);
    expect(bad).toEqual([]);
  });

  it('every org_id column is uuid not null', async () => {
    const bad = (await tablesWithOrgId())
      .filter((r) => r.type !== 'uuid' || !r.notnull)
      .map((r) => `${r.schema}.${r.name} (${r.type}${r.notnull ? '' : ', nullable'})`);
    expect(bad).toEqual([]);
  });

  it('the organization table has RLS enabled and forced, and its id is a uuid', async () => {
    const { sql } = w().loaded;
    const t = tableName(table(w().identity, 'organization'));
    const [r] = await rows<{ rls: boolean; forced: boolean; type: string }>(
      w().sup,
      sql`SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced, format_type(a.atttypid, a.atttypmod) AS type
          FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'id'
          WHERE n.nspname = ${t.schema} AND c.relname = ${t.name}`,
    );
    expect(r).toEqual({ rls: true, forced: true, type: 'uuid' });
  });

  it('every org table has a SELECT policy (the standard policy)', async () => {
    const { sql } = w().loaded;
    const org = tableName(table(w().identity, 'organization'));
    const targets = [
      org,
      ...(await tablesWithOrgId())
        .filter((r) => r.kind === 'r' || r.kind === 'p')
        .map((r) => ({ schema: r.schema, name: r.name })),
    ];
    for (const t of targets) {
      const policies = await rows<{ cmd: string }>(
        w().sup,
        sql`SELECT cmd FROM pg_policies WHERE schemaname = ${t.schema} AND tablename = ${t.name}`,
      );
      const cmds = policies.map((p) => p.cmd);
      expect(
        cmds.some((c) => c === 'SELECT' || c === 'ALL'),
        `${t.schema}.${t.name} has a SELECT policy`,
      ).toBe(true);
    }
  });

  it('grc_app owns none of the org tables (owners could switch RLS off)', async () => {
    const { sql } = w().loaded;
    const owned = await rows<{ name: string }>(
      w().sup,
      sql`SELECT c.relname AS name FROM pg_class c
          WHERE pg_get_userbyid(c.relowner) = 'grc_app' AND c.relkind IN ('r', 'p')`,
    );
    expect(owned).toEqual([]);
  });

  it('app_visible_org(uuid) exists and returns boolean', async () => {
    const { sql } = w().loaded;
    const found = await rows<{ result: string }>(
      w().sup,
      sql`SELECT pg_get_function_result(p.oid) AS result FROM pg_proc p
          WHERE p.proname = 'app_visible_org' AND pg_get_function_identity_arguments(p.oid) LIKE '%uuid'`,
    );
    expect(found.map((f) => f.result)).toEqual(['boolean']);
  });
});

describe('table shapes (Files section of the brief)', () => {
  it('schema.ts exports the eight Better Auth tables, and each exists after the migrations', async () => {
    const { sql } = w().loaded;
    for (const key of BETTER_AUTH_TABLES) {
      const t = tableName(table(w().identity, key));
      const [r] = await rows<{ n: string | number }>(
        w().sup,
        sql`SELECT count(*) AS n FROM pg_tables WHERE schemaname = ${t.schema} AND tablename = ${t.name}`,
      );
      expect(Number(r!.n), `table for ${key}`).toBe(1);
    }
  });

  it('grants.schema.ts exports auditorGrants, parentLinks and breakGlassSessions with the brief’s table names', () => {
    const names = GRANT_TABLES.map((k) => tableName(table(w().grants, k)).name);
    expect(names).toEqual([...GRANT_TABLE_NAMES]);
  });

  it('member.role accepts each of the 7 roles and refuses anything else', async () => {
    for (const role of ROLES) {
      const u = await addUser(w(), `role ${role}`);
      await insert(w().sup, table(w().identity, 'member'), {
        id: randomUUID(),
        organizationId: org.id,
        userId: u,
        role,
        createdAt: new Date(),
      });
    }
    for (const role of ['owner', 'member', 'superadmin', '']) {
      const u = await addUser(w(), `bad role ${role || 'empty'}`);
      await expect(
        insert(w().sup, table(w().identity, 'member'), {
          id: randomUUID(),
          organizationId: org.id,
          userId: u,
          role,
          createdAt: new Date(),
        }),
        `role '${role}'`,
      ).rejects.toThrow();
    }
  });

  it('member.clearance defaults to internal', async () => {
    const { sql } = w().loaded;
    const u = await addUser(w(), 'default clearance');
    const id = randomUUID();
    await insert(w().sup, table(w().identity, 'member'), {
      id,
      organizationId: org.id,
      userId: u,
      role: 'viewer',
      createdAt: new Date(),
    });
    const t = tableName(table(w().identity, 'member'));
    const [r] = await rows<{ clearance: string }>(
      w().sup,
      sql`SELECT clearance::text AS clearance FROM ${sql.raw(`"${t.schema}"."${t.name}"`)} WHERE id::text = ${id}`,
    );
    expect(r!.clearance).toBe('internal');
  });

  it('member.clearance accepts the 4 labels and refuses anything else', async () => {
    for (const clearance of LABELS) {
      const u = await addUser(w(), `clearance ${clearance}`);
      await insert(w().sup, table(w().identity, 'member'), {
        id: randomUUID(),
        organizationId: org.id,
        userId: u,
        role: 'viewer',
        clearance,
        createdAt: new Date(),
      });
    }
    for (const clearance of ['secret', 'top_secret', '']) {
      const u = await addUser(w(), `bad clearance ${clearance || 'empty'}`);
      await expect(
        insert(w().sup, table(w().identity, 'member'), {
          id: randomUUID(),
          organizationId: org.id,
          userId: u,
          role: 'viewer',
          clearance,
          createdAt: new Date(),
        }),
        `clearance '${clearance}'`,
      ).rejects.toThrow();
    }
  });
});
