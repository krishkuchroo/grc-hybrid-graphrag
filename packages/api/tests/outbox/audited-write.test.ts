// M0-013 criterion 1 (D37, D45.4): a graph change and its audit entry are saved together in one
// Neo4j transaction, as an (:AuditOutbox) node. If `fn` throws, or the transaction fails, neither
// the change nor the outbox node is kept. No relay runs in this file.
import type { ManagedTransaction } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACTOR,
  LONG,
  auditFor,
  loadOutbox,
  newOutboxOrg,
  outboxNodes,
  riskCount,
  setUpOutbox,
  tearDownOutbox,
  writeRisk,
  type GraphLike,
  type OutboxEnv,
  type OutboxModules,
  type SeededOrg,
} from './helpers.js';

let env: OutboxEnv | undefined;
let mods: OutboxModules | Error | undefined;
let org: SeededOrg;

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
  org = await newOutboxOrg(env, 'Outbox Write');
  // A missing file fails each test (not the set-up), naming the file.
  mods = await loadOutbox().catch((err: unknown) => err as Error);
}, LONG);

afterAll(async () => {
  await tearDownOutbox(env);
}, LONG);

describe('withAuditedWrite', () => {
  it('saves the change and one AuditOutbox node, and resolves to the result of fn', async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    const before = (await outboxNodes(e(), org.id)).length;

    const result = await writeRisk(outbox, org.id, 1);

    expect(result).toBe('saved-1');
    expect(await riskCount(e(), org.id, 'RSK0001001')).toBe(1);
    const nodes = await outboxNodes(e(), org.id);
    expect(nodes).toHaveLength(before + 1);
  }, 60_000);

  it('the outbox node has an id, the org ID, a payload and a creation time', async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    const before = new Set((await outboxNodes(e(), org.id)).map((n) => n.id));

    await writeRisk(outbox, org.id, 2);

    const added = (await outboxNodes(e(), org.id)).filter((n) => !before.has(n.id));
    expect(added).toHaveLength(1);
    const node = added[0]!;
    expect(typeof node.id, 'id is a string').toBe('string');
    expect(String(node.id).length).toBeGreaterThan(0);
    expect(node.orgId).toBe(org.id);
    expect(node.payload, 'payload holds the audit entry').not.toBeNull();
    expect(node.payload).not.toBeUndefined();
    expect(node.createdAt, 'createdAt is set').not.toBeNull();
    expect(node.createdAt).not.toBeUndefined();
  }, 60_000);

  it('each write gets its own outbox node with a distinct id', async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    const before = new Set((await outboxNodes(e(), org.id)).map((n) => n.id));

    for (let n = 10; n < 15; n++) await writeRisk(outbox, org.id, n);

    const added = (await outboxNodes(e(), org.id)).filter((n) => !before.has(n.id));
    expect(added).toHaveLength(5);
    expect(new Set(added.map((n) => n.id)).size).toBe(5);
  }, 60_000);

  it('if fn throws, neither the change nor the outbox node is saved, and the error reaches the caller', async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    const nodesBefore = (await outboxNodes(e(), org.id)).length;
    const boom = new Error('fn failed on purpose');

    await expect(
      outbox.withAuditedWrite(org.id, ACTOR, async (tx) => {
        await tx.run('CREATE (r:Risk {number: $number})', { number: 'RSK0009001' });
        throw boom;
      }),
    ).rejects.toBe(boom);

    expect(await riskCount(e(), org.id, 'RSK0009001'), 'the change was not kept').toBe(0);
    expect((await outboxNodes(e(), org.id)).length, 'no outbox node was kept').toBe(nodesBefore);
  }, 60_000);

  it('if fn throws after returning nothing useful (a rejected promise), nothing is saved', async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    const nodesBefore = (await outboxNodes(e(), org.id)).length;

    await expect(
      outbox.withAuditedWrite(org.id, ACTOR, (tx) =>
        tx
          .run('CREATE (r:Risk {number: $number})', { number: 'RSK0009002' })
          .then(() => Promise.reject(new Error('late failure'))),
      ),
    ).rejects.toThrow('late failure');

    expect(await riskCount(e(), org.id, 'RSK0009002')).toBe(0);
    expect((await outboxNodes(e(), org.id)).length).toBe(nodesBefore);
  }, 60_000);

  it('uses one graph.write transaction for the change and the outbox node', async () => {
    const real = e().graph;
    let writes = 0;
    const counting: Pick<GraphLike, 'write'> = {
      write: (orgId, fn) => {
        writes++;
        return real.write(orgId, fn);
      },
    };
    const outbox = new (m().AuditOutbox)(counting);
    const nodesBefore = (await outboxNodes(e(), org.id)).length;

    await writeRisk(outbox, org.id, 20);

    expect(writes, 'exactly one graph.write call per audited write').toBe(1);
    expect(await riskCount(e(), org.id, 'RSK0001020')).toBe(1);
    expect((await outboxNodes(e(), org.id)).length).toBe(nodesBefore + 1);
  }, 60_000);

  it('if the transaction fails after fn and the outbox node are done, neither is kept', async () => {
    const real = e().graph;
    const failing: Pick<GraphLike, 'write'> = {
      write: <T>(orgId: string, fn: (tx: ManagedTransaction) => Promise<T>) =>
        real.write(orgId, async (tx) => {
          await fn(tx);
          throw new Error('commit failed on purpose');
        }),
    };
    const outbox = new (m().AuditOutbox)(failing);
    const nodesBefore = (await outboxNodes(e(), org.id)).length;

    await expect(
      outbox.withAuditedWrite(org.id, ACTOR, async (tx) => {
        await tx.run('CREATE (r:Risk {number: $number})', { number: 'RSK0009003' });
        return { result: 'x', audit: auditFor(9003) };
      }),
    ).rejects.toThrow('commit failed on purpose');

    expect(await riskCount(e(), org.id, 'RSK0009003')).toBe(0);
    expect((await outboxNodes(e(), org.id)).length).toBe(nodesBefore);
  }, 60_000);

  it(
    'writes only in the org it was given',
    async () => {
      const other = await newOutboxOrg(e(), 'Outbox Write Other');
      const outbox = new (m().AuditOutbox)(e().graph);

      await writeRisk(outbox, org.id, 30);

      expect(await outboxNodes(e(), other.id)).toHaveLength(0);
      expect(await riskCount(e(), other.id)).toBe(0);
    },
    LONG,
  );
});
