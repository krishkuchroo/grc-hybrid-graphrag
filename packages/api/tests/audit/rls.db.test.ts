// M0-012 criterion 5 (D55, D59, D73): org A's context can't read org B's audit rows (RLS).
// Every ordered pair of three orgs, through the audit table and through each org's partition
// named directly (RLS on a partitioned table is not applied when a partition is queried).
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  adminCtx,
  appendMany,
  asApp,
  column,
  errorText,
  newOrg,
  partitionOf,
  rows,
  setUpAudit,
  stored,
  tearDownAudit,
  type AuditEnv,
  type SeededOrg,
} from './helpers.js';

let env: AuditEnv | undefined;
const orgs: SeededOrg[] = [];
const parts = new Map<string, string>();
const COUNTS = [3, 4, 5];

function e(): AuditEnv {
  if (!env) throw new Error('set-up did not finish');
  return env;
}

beforeAll(async () => {
  env = await setUpAudit();
  for (const [i, name] of ['Org A', 'Org B', 'Org C'].entries()) {
    const org = await newOrg(env, name);
    await appendMany(env, org.id, COUNTS[i]!);
    orgs.push(org);
    parts.set(org.id, await partitionOf(env, org.id));
  }
}, 180_000);

afterAll(async () => {
  await tearDownAudit(env);
});

// How many rows of `target` the caller sees in `rel`, or 'refused' if the read is refused.
async function seen(ctxOrg: SeededOrg, rel: string, target: string): Promise<number | 'refused'> {
  const { sql } = e().wall.loaded;
  try {
    const [r] = await asApp(e().wall, adminCtx(ctxOrg), (tx) =>
      rows<{ n: number }>(tx, sql.raw(`SELECT count(*)::int AS n FROM ${rel} WHERE org_id = '${target}'`)),
    );
    return r!.n;
  } catch (err) {
    if (/permission denied/i.test(errorText(err))) return 'refused';
    throw err;
  }
}

describe('criterion 5: every org pair is walled off in the audit trail', () => {
  it('each org sees its own audit rows through the audit table', async () => {
    for (const [i, org] of orgs.entries()) {
      expect(await seen(org, e().table.qualified, org.id), org.name).toBe(COUNTS[i]);
    }
  });

  it('for every ordered pair (A, B), A’s context sees none of B’s rows through the audit table', async () => {
    for (const a of orgs) {
      for (const b of orgs) {
        if (a === b) continue;
        expect(await seen(a, e().table.qualified, b.id), `${a.name} reading ${b.name}`).toBe(0);
      }
    }
  });

  it('A’s context reading the whole audit table sees only A’s org', async () => {
    const { sql } = e().wall.loaded;
    for (const a of orgs) {
      const found = await asApp(e().wall, adminCtx(a), (tx) =>
        rows<{ org: string }>(tx, sql.raw(`SELECT DISTINCT org_id::text AS org FROM ${e().table.qualified}`)),
      );
      expect(found.map((f) => f.org)).toEqual([a.id]);
    }
  });

  it('for every ordered pair (A, B), A’s context reading B’s partition directly sees nothing or is refused', async () => {
    for (const a of orgs) {
      for (const b of orgs) {
        if (a === b) continue;
        const result = await seen(a, parts.get(b.id)!, b.id);
        expect([0, 'refused'], `${a.name} reading ${b.name}'s partition`).toContain(result);
      }
    }
  });

  it('with no org context, grc_app sees no audit rows', async () => {
    const { sql } = e().wall.loaded;
    const [r] = await rows<{ n: number }>(e().appDb, sql.raw(`SELECT count(*)::int AS n FROM ${e().table.qualified}`));
    expect(r!.n).toBe(0);
  });

  it('A’s context can’t add a row to B’s chain directly', async () => {
    const { sql } = e().wall.loaded;
    const [a, b] = orgs as [SeededOrg, SeededOrg];
    const before = JSON.stringify(await stored(e(), b.id));
    const cols = ['orgId', 'seq', 'prevHash', 'hash', 'actorType', 'actorId', 'action'].map(
      (k) => `"${column(e(), k)}"`,
    );
    const text = `INSERT INTO ${e().table.qualified} (${cols.join(', ')})
                  VALUES ('${b.id}', 99, '${'0'.repeat(64)}', '${'1'.repeat(64)}', 'user', '${randomUUID()}', 'forged')`;
    let refused = '';
    try {
      await asApp(e().wall, adminCtx(a), (tx) => tx.execute(sql.raw(text) as never));
    } catch (err) {
      refused = errorText(err);
    }
    expect(refused).not.toBe('');
    expect(JSON.stringify(await stored(e(), b.id))).toBe(before);
  });

  it('the service appends to the org named in the event only: a chain in one org never shows up in another', async () => {
    const [a, b, c] = orgs as [SeededOrg, SeededOrg, SeededOrg];
    await e().audit.append({ orgId: a.id, actorType: 'system', actorId: 'system', action: 'probe.a' });
    expect((await stored(e(), a.id)).some((r) => r.action === 'probe.a')).toBe(true);
    expect((await stored(e(), b.id)).some((r) => r.action === 'probe.a')).toBe(false);
    expect((await stored(e(), c.id)).some((r) => r.action === 'probe.a')).toBe(false);
  });
});
