// M0-012 criteria 1, 2 and 6 (D56, D73), against a throwaway database, as grc_app.
// 1. Sequence numbers per org start at 1 with no gaps. Each entry stores the previous entry's hash.
// 2. 50 appends at once for one org give 50 entries, seq 1-50, one unbroken chain.
// 6. Appending the same sourceId twice stores one entry.
// Plus createAuditPartition (called by org provisioning, M0-014): one partition per org, safe to re-run.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  event,
  newOrg,
  partitionOf,
  rows,
  setUpAudit,
  stored,
  tearDownAudit,
  type AuditEnv,
  type StoredEvent,
} from './helpers.js';

let env: AuditEnv | undefined;

function e(): AuditEnv {
  if (!env) throw new Error('set-up did not finish');
  return env;
}

beforeAll(async () => {
  env = await setUpAudit();
}, 180_000);

afterAll(async () => {
  await tearDownAudit(env);
});

function expectLinked(found: StoredEvent[], count: number): void {
  expect(found.map((r) => r.seq)).toEqual(Array.from({ length: count }, (_, i) => i + 1));
  for (let i = 1; i < found.length; i++) {
    expect(found[i]!.prevHash, `seq ${found[i]!.seq} stores the hash of seq ${found[i - 1]!.seq}`).toBe(
      found[i - 1]!.hash,
    );
  }
  expect(new Set(found.map((r) => r.hash)).size, 'every hash is distinct').toBe(count);
}

describe('createAuditPartition', () => {
  it('creates one partition of the audit table for the org', async () => {
    const org = await newOrg(e(), 'Partition Org');
    await expect(partitionOf(e(), org.id)).resolves.toMatch(/"/);
  });

  it('is safe to call again for the same org', async () => {
    const org = await newOrg(e(), 'Partition Rerun');
    await e().mods.createAuditPartition(e().migrator, org.id);
    await expect(partitionOf(e(), org.id)).resolves.toMatch(/"/);
    const { seq } = await e().audit.append(event(org.id, 1));
    expect(seq).toBe(1);
  });

  it('turns RLS on and forces it on the new partition, and gives it a SELECT policy', async () => {
    const org = await newOrg(e(), 'Partition Rls');
    const part = await partitionOf(e(), org.id);
    const { sql } = e().wall.loaded;
    const [r] = await rows<{ rls: boolean; forced: boolean }>(
      e().wall.sup,
      sql`SELECT relrowsecurity AS rls, relforcerowsecurity AS forced FROM pg_class WHERE oid = ${part}::regclass`,
    );
    expect(r).toEqual({ rls: true, forced: true });
    const policies = await rows<{ cmd: string }>(
      e().wall.sup,
      sql`SELECT p.cmd FROM pg_policies p
          JOIN pg_class c ON c.relname = p.tablename
          JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = p.schemaname
          WHERE c.oid = ${part}::regclass`,
    );
    expect(policies.some((p) => p.cmd === 'SELECT' || p.cmd === 'ALL')).toBe(true);
  });

  it('the audit table keeps its org in org_id uuid not null', async () => {
    const { sql } = e().wall.loaded;
    const [r] = await rows<{ type: string; notnull: boolean }>(
      e().wall.sup,
      sql`SELECT format_type(atttypid, atttypmod) AS type, attnotnull AS notnull FROM pg_attribute
          WHERE attrelid = ${e().table.qualified}::regclass AND attname = 'org_id'`,
    );
    expect(r).toEqual({ type: 'uuid', notnull: true });
  });
});

describe('criterion 1: per-org sequence from 1 with no gaps, each entry storing the previous hash', () => {
  it('the first append for an org gets seq 1, and append returns the stored seq and hash', async () => {
    const org = await newOrg(e(), 'First Org');
    const out = await e().audit.append(event(org.id, 1));
    expect(out.seq).toBe(1);
    expect(out.hash).toMatch(/^[0-9a-f]{64}$/);
    const found = await stored(e(), org.id);
    expect(found).toHaveLength(1);
    expect(found[0]!.seq).toBe(1);
    expect(found[0]!.hash).toBe(out.hash);
  });

  it('10 appends in a row give seq 1-10, each storing the previous entry’s hash', async () => {
    const org = await newOrg(e(), 'Ten Org');
    const outs: { seq: number; hash: string }[] = [];
    for (let i = 1; i <= 10; i++) outs.push(await e().audit.append(event(org.id, i)));
    expect(outs.map((o) => o.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const found = await stored(e(), org.id);
    expectLinked(found, 10);
    expect(found.map((r) => r.hash)).toEqual(outs.map((o) => o.hash));
  });

  it('stores what was appended: actor, action and org', async () => {
    const org = await newOrg(e(), 'Fields Org');
    await e().audit.append(event(org.id, 1, { actorType: 'api_key', actorId: 'key-42', action: 'push.batch' }));
    const [row] = await stored(e(), org.id);
    expect(row).toMatchObject({ orgId: org.id, actorType: 'api_key', actorId: 'key-42', action: 'push.batch' });
  });

  it('each org has its own sequence: two orgs appending in turn both count 1, 2, 3 …', async () => {
    const a = await newOrg(e(), 'Seq A');
    const b = await newOrg(e(), 'Seq B');
    for (let i = 1; i <= 5; i++) {
      expect((await e().audit.append(event(a.id, i))).seq).toBe(i);
      expect((await e().audit.append(event(b.id, i))).seq).toBe(i);
    }
    expectLinked(await stored(e(), a.id), 5);
    expectLinked(await stored(e(), b.id), 5);
  });

  it('the chain passes verifyChain', async () => {
    const org = await newOrg(e(), 'Verify Org');
    for (let i = 1; i <= 5; i++) await e().audit.append(event(org.id, i));
    await expect(e().audit.verifyChain(org.id)).resolves.toEqual({ ok: true });
  });
});

describe('criterion 2: 50 appends at once for one org', () => {
  it('give 50 entries, seq 1-50, one unbroken chain with no forks and no duplicates', async () => {
    const org = await newOrg(e(), 'Burst Org');
    const outs = await Promise.all(Array.from({ length: 50 }, (_, i) => e().audit.append(event(org.id, i + 1))));
    expect(outs.map((o) => o.seq).sort((x, y) => x - y)).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    const found = await stored(e(), org.id);
    expectLinked(found, 50);
    const prevs = found.slice(1).map((r) => r.prevHash);
    expect(new Set(prevs).size, 'no two entries claim the same previous entry (a fork)').toBe(49);
    await expect(e().audit.verifyChain(org.id)).resolves.toEqual({ ok: true });
  }, 60_000);

  it('bursts for two orgs at once keep each org’s chain separate and unbroken', async () => {
    const a = await newOrg(e(), 'Burst A');
    const b = await newOrg(e(), 'Burst B');
    await Promise.all(
      Array.from({ length: 30 }, (_, i) => [
        e().audit.append(event(a.id, i + 1)),
        e().audit.append(event(b.id, i + 1)),
      ]).flat(),
    );
    expectLinked(await stored(e(), a.id), 30);
    expectLinked(await stored(e(), b.id), 30);
    await expect(e().audit.verifyChain(a.id)).resolves.toEqual({ ok: true });
    await expect(e().audit.verifyChain(b.id)).resolves.toEqual({ ok: true });
  }, 60_000);
});

describe('criterion 6: the same sourceId twice stores one entry', () => {
  it('a repeat append with the same sourceId is a no-op and returns the first entry’s seq and hash', async () => {
    const org = await newOrg(e(), 'Source Org');
    await e().audit.append(event(org.id, 1));
    const first = await e().audit.append(event(org.id, 2, { sourceId: 'outbox-1' }));
    const again = await e().audit.append(event(org.id, 2, { sourceId: 'outbox-1' }));
    expect(again).toEqual(first);
    const found = await stored(e(), org.id);
    expect(found).toHaveLength(2);
    expect(found.filter((r) => r.sourceId === 'outbox-1')).toHaveLength(1);
    const next = await e().audit.append(event(org.id, 3, { sourceId: 'outbox-2' }));
    expect(next.seq, 'the no-op used up no sequence number').toBe(3);
    expectLinked(await stored(e(), org.id), 3);
  });

  it('10 appends at once with the same sourceId store one entry and leave the chain unbroken', async () => {
    const org = await newOrg(e(), 'Source Burst');
    await Promise.all(Array.from({ length: 10 }, () => e().audit.append(event(org.id, 1, { sourceId: 'outbox-x' }))));
    const found = await stored(e(), org.id);
    expect(found).toHaveLength(1);
    expect(found[0]!.seq).toBe(1);
    await expect(e().audit.verifyChain(org.id)).resolves.toEqual({ ok: true });
  });

  it('the same sourceId in two different orgs stores one entry in each (unique per org)', async () => {
    const a = await newOrg(e(), 'Source A');
    const b = await newOrg(e(), 'Source B');
    await e().audit.append(event(a.id, 1, { sourceId: 'shared-id' }));
    await e().audit.append(event(b.id, 1, { sourceId: 'shared-id' }));
    expect(await stored(e(), a.id)).toHaveLength(1);
    expect(await stored(e(), b.id)).toHaveLength(1);
  });

  it('appends without a sourceId are never merged', async () => {
    const org = await newOrg(e(), 'No Source');
    await e().audit.append(event(org.id, 1));
    await e().audit.append(event(org.id, 1));
    expect(await stored(e(), org.id)).toHaveLength(2);
  });
});
