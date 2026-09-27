// M0-013 criterion 3 (D45.5, D48): the relay is killed between the Postgres append and the Neo4j
// delete. After a restart there is exactly one audit row per entry, nothing is left in the
// outbox, and the chain verifies. The kill is injected through the relay's audit dependency: the
// first append commits in Postgres, then the "process" dies before it can delete the node.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  auditRows,
  crashAfterFirstAppend,
  loadOutbox,
  newOutboxOrg,
  ns,
  outboxNodes,
  relay,
  setUpOutbox,
  settle,
  tearDownOutbox,
  writeRisk,
  type OutboxEnv,
  type OutboxModules,
  type SeededOrg,
} from './helpers.js';

let env: OutboxEnv | undefined;
let mods: OutboxModules | Error | undefined;
let single: SeededOrg;
let several: SeededOrg;
let concurrent: SeededOrg;

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
  single = await newOutboxOrg(env, 'Crash Single');
  several = await newOutboxOrg(env, 'Crash Several');
  concurrent = await newOutboxOrg(env, 'Crash Concurrent');
  // A missing file fails each test (not the set-up), naming the file.
  mods = await loadOutbox().catch((err: unknown) => err as Error);
}, LONG);

afterAll(async () => {
  await tearDownOutbox(env);
}, LONG);

describe('a relay killed between the Postgres append and the Neo4j delete', () => {
  it('leaves exactly one audit row after a restart', async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    await writeRisk(outbox, single.id, 1);
    const [node] = await outboxNodes(e(), single.id);

    const crashing = crashAfterFirstAppend(e().audit.audit);
    await settle(relay(e(), m(), { orgs: [single.id], audit: crashing }).runOnce());

    // The kill landed where we wanted: the row is in Postgres and the node is still in Neo4j.
    expect(crashing.appended, 'the append committed before the kill').toBe(1);
    expect(await auditRows(e(), single.id)).toHaveLength(1);
    expect(await outboxNodes(e(), single.id), 'the node was not deleted before the kill').toHaveLength(1);

    // Restart: a fresh relay with a working Postgres.
    await relay(e(), m(), { orgs: [single.id] }).runOnce();

    const found = await auditRows(e(), single.id);
    expect(found, 'exactly one audit row').toHaveLength(1);
    expect(found[0]!.sourceId).toBe(String(node!.id));
    expect(await outboxNodes(e(), single.id), 'the outbox is empty after the restart').toHaveLength(0);
    expect(await e().audit.audit.verifyChain(single.id)).toEqual({ ok: true });
  }, 60_000);

  it('with several entries waiting, each ends up in Postgres exactly once and in order', async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    for (let n = 1; n <= 5; n++) await writeRisk(outbox, several.id, n);

    const crashing = crashAfterFirstAppend(e().audit.audit);
    await settle(relay(e(), m(), { orgs: [several.id], audit: crashing }).runOnce());
    expect(await auditRows(e(), several.id)).toHaveLength(1);
    expect(await outboxNodes(e(), several.id)).toHaveLength(5);

    await relay(e(), m(), { orgs: [several.id] }).runOnce();

    const found = await auditRows(e(), several.id);
    expect(ns(found)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(found.map((r) => r.sourceId)).size).toBe(5);
    expect(await outboxNodes(e(), several.id)).toHaveLength(0);
    expect(await e().audit.audit.verifyChain(several.id)).toEqual({ ok: true });
  }, 60_000);

  it('a crash then two relays restarting at once still copies each entry exactly once', async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    for (let n = 1; n <= 8; n++) await writeRisk(outbox, concurrent.id, n);
    await settle(relay(e(), m(), { orgs: [concurrent.id], audit: crashAfterFirstAppend(e().audit.audit) }).runOnce());

    const a = relay(e(), m(), { orgs: [concurrent.id] });
    const b = relay(e(), m(), { orgs: [concurrent.id] });
    await Promise.all([settle(a.runOnce()), settle(b.runOnce())]);
    // Whatever one pass left (it may have lost a delete race), one more pass finishes.
    await relay(e(), m(), { orgs: [concurrent.id] }).runOnce();

    const found = await auditRows(e(), concurrent.id);
    expect(found).toHaveLength(8);
    expect([...ns(found)].sort((x, y) => x - y)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(await outboxNodes(e(), concurrent.id)).toHaveLength(0);
    expect(await e().audit.audit.verifyChain(concurrent.id)).toEqual({ ok: true });
  }, 60_000);
});
