// M0-013 criterion 2 (D37, D48, D73): after a successful write, the audit row is in Postgres
// within 5 s. The relay runs every 2 s, appends each outbox entry with sourceId = the outbox node's
// id, and only then deletes the node.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTOR,
  LONG,
  auditRows,
  loadOutbox,
  newOutboxOrg,
  outboxNodes,
  relay,
  riskId,
  setUpOutbox,
  tearDownOutbox,
  waitFor,
  writeRisk,
  type OutboxEnv,
  type OutboxModules,
  type SeededOrg,
} from './helpers.js';
import { runOn } from '../graph/helpers.js';

let env: OutboxEnv | undefined;
let mods: OutboxModules | Error | undefined;
let copyOrg: SeededOrg;
let timedOrg: SeededOrg;
let orgA: SeededOrg;
let orgB: SeededOrg;

function e(): OutboxEnv {
  if (!env) throw new Error('set-up did not finish');
  return env;
}

function m(): OutboxModules {
  if (mods instanceof Error) throw mods;
  if (!mods) throw new Error('set-up did not finish');
  return mods;
}

beforeAll(async () => {
  env = await setUpOutbox();
  copyOrg = await newOutboxOrg(env, 'Relay Copy');
  timedOrg = await newOutboxOrg(env, 'Relay Timed');
  orgA = await newOutboxOrg(env, 'Relay Forge A');
  orgB = await newOutboxOrg(env, 'Relay Forge B');
  // A missing file fails each test (not the set-up), naming the file.
  mods = await loadOutbox().catch((err: unknown) => err as Error);
}, LONG);

afterAll(async () => {
  await tearDownOutbox(env);
}, LONG);

describe('the outbox relay', () => {
  it('runs every 2 s by default', () => {
    expect(m().OUTBOX_RELAY_INTERVAL_MS).toBe(2000);
  });

  it('copies an entry to Postgres with its actor, action, target, before, after, meta and sourceId = outbox id', async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    await outbox.withAuditedWrite(copyOrg.id, { actorType: 'api_key', actorId: 'key-42' }, async (tx) => {
      await tx.run('CREATE (r:Risk {number: $number})', { number: riskId(7) });
      return {
        result: null,
        audit: {
          action: 'risk.created',
          targetType: 'Risk',
          targetId: riskId(7),
          before: null,
          after: { title: 'Laptop theft', score: 12, tags: ['physical', 'endpoint'] },
          meta: { n: 7, requestId: 'req-7' },
        },
      };
    });
    const [node] = await outboxNodes(e(), copyOrg.id);
    expect(node, 'the write left one outbox node').toBeDefined();

    await relay(e(), m(), { orgs: [copyOrg.id] }).runOnce();

    const found = await auditRows(e(), copyOrg.id);
    expect(found).toHaveLength(1);
    const row = found[0]!;
    expect(row).toMatchObject({
      orgId: copyOrg.id,
      seq: 1,
      actorType: 'api_key',
      actorId: 'key-42',
      action: 'risk.created',
      targetType: 'Risk',
      targetId: riskId(7),
      sourceId: String(node!.id),
    });
    expect(row.before).toBeNull();
    expect(row.after).toEqual({ title: 'Laptop theft', score: 12, tags: ['physical', 'endpoint'] });
    expect(row.meta).toEqual({ n: 7, requestId: 'req-7' });
  }, 60_000);

  it('deletes the outbox node once its entry is in Postgres (D73)', async () => {
    expect(await outboxNodes(e(), copyOrg.id)).toHaveLength(0);
    expect(await auditRows(e(), copyOrg.id)).toHaveLength(1);
  });

  it('a second pass with nothing new copies nothing again', async () => {
    await relay(e(), m(), { orgs: [copyOrg.id] }).runOnce();
    expect(await auditRows(e(), copyOrg.id)).toHaveLength(1);
  }, 60_000);

  it('the copied chain verifies', async () => {
    expect(await auditRows(e(), copyOrg.id)).toHaveLength(1);
    expect(await e().audit.audit.verifyChain(copyOrg.id)).toEqual({ ok: true });
  });

  it('with the relay started, each write reaches Postgres within 5 s', async () => {
    const r = relay(e(), m(), { orgs: [timedOrg.id] });
    r.start();
    const outbox = new (m().AuditOutbox)(e().graph);
    try {
      for (let n = 1; n <= 3; n++) {
        await writeRisk(outbox, timedOrg.id, n);
        const saved = Date.now();
        await waitFor(
          `audit row ${n} in Postgres`,
          async () => (await auditRows(e(), timedOrg.id)).length >= n,
          5_000,
          50,
        );
        const took = Date.now() - saved;
        expect(took, `entry ${n} reached Postgres after ${took} ms`).toBeLessThan(5_000);
        // Space the writes so they land at different points of the 2 s cycle.
        await new Promise((resolve) => setTimeout(resolve, 700 * n));
      }
    } finally {
      await r.stop();
    }
    const found = await auditRows(e(), timedOrg.id);
    expect(found.map((row) => row.actorId)).toEqual([ACTOR.actorId, ACTOR.actorId, ACTOR.actorId]);
    expect(await outboxNodes(e(), timedOrg.id)).toHaveLength(0);
  }, 60_000);

  it('after stop() resolves, no more entries are copied', async () => {
    const r = relay(e(), m(), { orgs: [timedOrg.id] });
    r.start();
    await r.stop();
    const before = (await auditRows(e(), timedOrg.id)).length;
    await writeRisk(new (m().AuditOutbox)(e().graph), timedOrg.id, 50);

    await new Promise((resolve) => setTimeout(resolve, 5_000));

    expect(await auditRows(e(), timedOrg.id)).toHaveLength(before);
    expect(await outboxNodes(e(), timedOrg.id)).toHaveLength(1);
  }, 30_000);

  it("an outbox node in org A's database is never appended to another org's chain, whatever its orgId says", async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    await writeRisk(outbox, orgA.id, 1);
    await runOn(e().sup, `org-${orgA.id}`, 'MATCH (o:AuditOutbox) SET o.orgId = $other', { other: orgB.id });

    await relay(e(), m(), { orgs: [orgA.id, orgB.id] })
      .runOnce()
      .catch(() => undefined);

    expect(await auditRows(e(), orgB.id), "nothing reached org B's chain").toHaveLength(0);
  }, 60_000);
});
