// M0-012 criterion 3 (D56, D57, D73): grc_app can't UPDATE, DELETE or TRUNCATE audit rows.
// A trigger also refuses changes by the owner (grc_migrator) at runtime.
// Checked on the audit table and on an org's partition, because a partition can be named directly.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminCtx,
  appendMany,
  asApp,
  column,
  errorText,
  newOrg,
  partitionOf,
  Rollback,
  rolledBack,
  rows,
  setUpAudit,
  stored,
  tearDownAudit,
  type AuditEnv,
  type SeededOrg,
} from './helpers.js';

let env: AuditEnv | undefined;
let org: SeededOrg;
let part: string;
let before: string;

function e(): AuditEnv {
  if (!env) throw new Error('set-up did not finish');
  return env;
}

beforeAll(async () => {
  env = await setUpAudit();
  org = await newOrg(env, 'Add Only Org');
  await appendMany(env, org.id, 5);
  part = await partitionOf(env, org.id);
  before = JSON.stringify(await stored(env, org.id));
}, 180_000);

afterAll(async () => {
  await tearDownAudit(env);
});

async function unchanged(): Promise<void> {
  expect(JSON.stringify(await stored(e(), org.id)), 'the stored rows are unchanged').toBe(before);
}

function targets(): { label: string; rel: string }[] {
  return [
    { label: 'audit table', rel: e().table.qualified },
    { label: 'org partition', rel: part },
  ];
}

function statements(rel: string): { verb: string; text: string }[] {
  const action = column(e(), 'action');
  return [
    { verb: 'UPDATE', text: `UPDATE ${rel} SET "${action}" = 'tampered' WHERE org_id = '${org.id}'` },
    { verb: 'DELETE', text: `DELETE FROM ${rel} WHERE org_id = '${org.id}'` },
    { verb: 'TRUNCATE', text: `TRUNCATE ${rel}` },
  ];
}

describe('criterion 3: grc_app has no UPDATE, DELETE or TRUNCATE right on audit rows', () => {
  for (const verb of ['UPDATE', 'DELETE', 'TRUNCATE'] as const) {
    it(`grc_app has no ${verb} privilege on the audit table or on the org's partition`, async () => {
      const { sql } = e().wall.loaded;
      for (const t of targets()) {
        const [r] = await rows<{ has: boolean }>(
          e().wall.sup,
          sql`SELECT has_table_privilege('grc_app', ${t.rel}::regclass, ${verb}) AS has`,
        );
        expect(r!.has, `${verb} on the ${t.label}`).toBe(false);
      }
    });
  }

  it('grc_app can still read the audit table (under RLS)', async () => {
    const { sql } = e().wall.loaded;
    const [r] = await rows<{ has: boolean }>(
      e().wall.sup,
      sql`SELECT has_table_privilege('grc_app', ${e().table.qualified}::regclass, 'SELECT') AS has`,
    );
    expect(r!.has).toBe(true);
  });

  for (const verb of ['UPDATE', 'DELETE', 'TRUNCATE'] as const) {
    it(`grc_app in its own org's context is refused when it runs ${verb}, and nothing changes`, async () => {
      const { sql } = e().wall.loaded;
      for (const t of targets()) {
        const stmt = statements(t.rel).find((s) => s.verb === verb)!;
        let refused = '';
        try {
          await asApp(e().wall, adminCtx(org), (tx) => tx.execute(sql.raw(stmt.text) as never));
        } catch (err) {
          refused = errorText(err);
        }
        expect(refused, `${verb} on the ${t.label} is refused`).toMatch(/permission denied|not allowed|refus/i);
        await unchanged();
      }
    });
  }

  it('grc_app cannot switch the trigger off or lift RLS (it does not own the table)', async () => {
    const { sql } = e().wall.loaded;
    for (const text of [
      `ALTER TABLE ${e().table.qualified} DISABLE TRIGGER USER`,
      `ALTER TABLE ${e().table.qualified} NO FORCE ROW LEVEL SECURITY`,
      `ALTER TABLE ${part} DISABLE TRIGGER USER`,
    ]) {
      await expect(
        asApp(e().wall, adminCtx(org), (tx) => tx.execute(sql.raw(text) as never)),
        text,
      ).rejects.toThrow();
    }
    await unchanged();
  });
});

describe('criterion 3: a trigger refuses changes by the owner at runtime', () => {
  // The owner is subject to FORCE RLS and has no policy, so it would see no rows and a row
  // trigger would never fire. The test lifts FORCE RLS inside a rolled-back transaction, checks
  // the owner now sees the rows, then tries each change in a savepoint.
  for (const verb of ['UPDATE', 'DELETE', 'TRUNCATE'] as const) {
    it(`grc_migrator (the owner) is refused when it runs ${verb}, on the table and on the partition`, async () => {
      const { sql } = e().wall.loaded;
      for (const t of targets()) {
        const stmt = statements(t.rel).find((s) => s.verb === verb)!;
        let outcome = '';
        await rolledBack(() =>
          e().migrator.transaction(async (tx) => {
            await tx.execute(sql.raw(`ALTER TABLE ${e().table.qualified} NO FORCE ROW LEVEL SECURITY`));
            await tx.execute(sql.raw(`ALTER TABLE ${part} NO FORCE ROW LEVEL SECURITY`));
            const [seen] = await rows<{ n: number }>(
              tx,
              sql.raw(`SELECT count(*)::int AS n FROM ${t.rel} WHERE org_id = '${org.id}'`),
            );
            expect(seen!.n, 'the owner sees the rows once FORCE RLS is lifted').toBe(5);
            try {
              await tx.transaction(async (sp) => {
                await sp.execute(sql.raw(stmt.text));
              });
            } catch (err) {
              outcome = errorText(err);
            }
            throw new Rollback();
          }),
        );
        expect(outcome, `${verb} by the owner on the ${t.label} is refused by a trigger`).not.toBe('');
        await unchanged();
      }
    });
  }
});
