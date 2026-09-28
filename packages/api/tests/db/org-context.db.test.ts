// M0-003 criteria 4 and 5: the per-transaction org context that RLS relies on (D73).
// `withOrgContext(db, { orgId, userId, role, clearance }, fn)` runs `fn(tx)` in one
// transaction after `SET LOCAL app.org_id`, `app.user_id`, `app.role` and `app.clearance`.
// 4. Inside, the settings hold the given values. After the transaction they are gone, and
//    don't leak into the next pooled use (checked on a one-connection pool).
// Criterion 5 (invalid input) is in org-context-input.unit.test.ts.
// Everything here runs as grc_app through DATABASE_URL_APP (see helpers.ts).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appUrl,
  closeDb,
  createThrowaway,
  dropThrowaway,
  load,
  migrateUrl,
  rows,
  runMigrations,
  type Db,
  type Loaded,
} from './helpers.js';

const ROLES = ['admin', 'risk_manager', 'compliance_manager', 'control_owner', 'auditor', 'analyst', 'viewer'] as const;
const LABELS = ['public', 'internal', 'confidential', 'restricted'] as const;

type WithOrgContext = Loaded['withOrgContext'];
type Ctx = Parameters<WithOrgContext>[1];

function ctx(over: Partial<Record<keyof Ctx, string>> = {}): Ctx {
  return {
    orgId: randomUUID(),
    userId: randomUUID(),
    role: 'risk_manager',
    clearance: 'confidential',
    ...over,
  } as unknown as Ctx;
}

interface Settings {
  org_id: string | null;
  user_id: string | null;
  role: string | null;
  clearance: string | null;
  pid: number;
}

let loaded: Loaded;
let dbName = '';
let one: Db | undefined; // a pool with exactly one connection

beforeAll(async () => {
  loaded = await load();
  dbName = await createThrowaway(loaded);
  const result = await runMigrations(migrateUrl(dbName));
  if (!result.ok) throw new Error(`drizzle-kit migrate failed:\n${result.output}`);
  one = loaded.createDb(appUrl(dbName), { max: 1 });
}, 180_000);

afterAll(async () => {
  await closeDb(one);
  if (loaded && dbName) await dropThrowaway(loaded, dbName);
});

function pool(): Db {
  if (!one) throw new Error('set-up did not finish');
  return one;
}

async function readSettings(db: { execute: (q: never) => Promise<unknown> }): Promise<Settings> {
  const [r] = await rows<Settings>(
    db,
    loaded.sql`SELECT current_setting('app.org_id', true) AS org_id,
                      current_setting('app.user_id', true) AS user_id,
                      current_setting('app.role', true) AS role,
                      current_setting('app.clearance', true) AS clearance,
                      pg_backend_pid() AS pid`,
  );
  return r!;
}

// After a SET LOCAL ends, Postgres leaves a custom setting defined but empty.
function cleared(v: string | null): boolean {
  return v === null || v === '';
}

describe('inside withOrgContext (criterion 4)', () => {
  it('the four settings hold the given values', async () => {
    const c = ctx();
    const seen = await loaded.withOrgContext(pool(), c, (tx) => readSettings(tx as never));
    expect(seen.org_id).toBe(c.orgId);
    expect(seen.user_id).toBe(c.userId);
    expect(seen.role).toBe(c.role);
    expect(seen.clearance).toBe(c.clearance);
  });

  it('returns what fn returns', async () => {
    const result = await loaded.withOrgContext(pool(), ctx(), async () => 'the result');
    expect(result).toBe('the result');
  });

  it('fn runs inside one transaction', async () => {
    const ids = await loaded.withOrgContext(pool(), ctx(), async (tx) => {
      const [a] = await rows<{ x: string }>(tx as never, loaded.sql`SELECT pg_current_xact_id()::text AS x`);
      const [b] = await rows<{ x: string }>(tx as never, loaded.sql`SELECT pg_current_xact_id()::text AS x`);
      return { a: a?.x, b: b?.x };
    });
    expect(ids.a).toBeDefined();
    expect(ids.a).toBe(ids.b);
  });

  it.each(ROLES)('accepts the role %s and sets app.role to it', async (role) => {
    const seen = await loaded.withOrgContext(pool(), ctx({ role }), (tx) => readSettings(tx as never));
    expect(seen.role).toBe(role);
  });

  it.each(LABELS)('accepts the clearance %s and sets app.clearance to it', async (clearance) => {
    const seen = await loaded.withOrgContext(pool(), ctx({ clearance }), (tx) => readSettings(tx as never));
    expect(seen.clearance).toBe(clearance);
  });
});

describe('after withOrgContext (criterion 4)', () => {
  it('the settings are gone on the same pooled connection', async () => {
    const inside = await loaded.withOrgContext(pool(), ctx(), (tx) => readSettings(tx as never));
    const outside = await readSettings(pool());
    expect(outside.pid).toBe(inside.pid); // same connection, so this is a real leak check
    expect(cleared(outside.org_id)).toBe(true);
    expect(cleared(outside.user_id)).toBe(true);
    expect(cleared(outside.role)).toBe(true);
    expect(cleared(outside.clearance)).toBe(true);
  });

  it('two back-to-back calls on a one-connection pool each see only their own settings', async () => {
    const first = ctx({ role: 'admin', clearance: 'restricted' });
    const second = ctx({ role: 'viewer', clearance: 'public' });

    const a = await loaded.withOrgContext(pool(), first, (tx) => readSettings(tx as never));
    const between = await readSettings(pool());
    const b = await loaded.withOrgContext(pool(), second, (tx) => readSettings(tx as never));
    const afterBoth = await readSettings(pool());

    expect(new Set([a.pid, between.pid, b.pid, afterBoth.pid]).size).toBe(1);
    expect(a).toMatchObject({ org_id: first.orgId, user_id: first.userId, role: 'admin', clearance: 'restricted' });
    expect(cleared(between.org_id) && cleared(between.role) && cleared(between.clearance)).toBe(true);
    expect(b).toMatchObject({ org_id: second.orgId, user_id: second.userId, role: 'viewer', clearance: 'public' });
    expect(b.org_id).not.toBe(first.orgId);
    expect(cleared(afterBoth.org_id) && cleared(afterBoth.user_id)).toBe(true);
  });

  it('when fn throws, the error comes back and the settings are still gone', async () => {
    const boom = new Error('fn failed on purpose');
    let pidInside = -1;
    await expect(
      loaded.withOrgContext(pool(), ctx(), async (tx) => {
        pidInside = (await readSettings(tx as never)).pid;
        throw boom;
      }),
    ).rejects.toBe(boom);
    const outside = await readSettings(pool());
    expect(outside.pid).toBe(pidInside);
    expect(cleared(outside.org_id)).toBe(true);
    expect(cleared(outside.role)).toBe(true);
  });

  it('when fn throws, the transaction is rolled back', async () => {
    // A session-level set_config inside a transaction survives a commit but not a rollback.
    await expect(
      loaded.withOrgContext(pool(), ctx(), async (tx) => {
        await rows(tx as never, loaded.sql`SELECT set_config('app.rollback_probe', 'written', false)`);
        throw new Error('roll back');
      }),
    ).rejects.toThrow('roll back');
    const [r] = await rows<{ v: string | null }>(
      pool(),
      loaded.sql`SELECT current_setting('app.rollback_probe', true) AS v`,
    );
    expect(cleared(r?.v ?? null)).toBe(true);
  });
});
