// M0-013 criterion 5 (D37, D45.7, D48): with Postgres down, entries stay in the outbox and are
// copied once it is back. "Down" is a real AuditService whose Postgres can't be reached (nothing
// listens on the port); "back" switches the relay to the working one. The shared grc-postgres
// container is never stopped.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  auditRows,
  downAudit,
  loadOutbox,
  newOutboxOrg,
  ns,
  outboxNodes,
  relay,
  riskCount,
  setUpOutbox,
  settle,
  switchableAudit,
  tearDownOutbox,
  waitFor,
  writeRisk,
  type OutboxEnv,
  type OutboxModules,
  type SeededOrg,
} from './helpers.js';

let env: OutboxEnv | undefined;
let mods: OutboxModules | Error | undefined;
let once: SeededOrg;
let looping: SeededOrg;

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
  once = await newOutboxOrg(env, 'Down Once');
  looping = await newOutboxOrg(env, 'Down Loop');
  // A missing file fails each test (not the set-up), naming the file.
  mods = await loadOutbox().catch((err: unknown) => err as Error);
}, LONG);

afterAll(async () => {
  await tearDownOutbox(env);
}, LONG);

describe('the relay while Postgres is down', () => {
  it('writes still succeed in Neo4j while Postgres is unreachable', async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    for (let n = 1; n <= 3; n++) expect(await writeRisk(outbox, once.id, n)).toBe(`saved-${n}`);
    expect(await riskCount(e(), once.id)).toBe(3);
  }, 60_000);

  it('a pass against an unreachable Postgres keeps every entry in the outbox', async () => {
    await settle(relay(e(), m(), { orgs: [once.id], audit: downAudit(e()) }).runOnce());

    expect(await outboxNodes(e(), once.id)).toHaveLength(3);
    expect(await auditRows(e(), once.id)).toHaveLength(0);
  }, 60_000);

  it('once Postgres is back, the waiting entries are copied, once each and in order', async () => {
    await relay(e(), m(), { orgs: [once.id] }).runOnce();

    expect(ns(await auditRows(e(), once.id))).toEqual([1, 2, 3]);
    expect(await outboxNodes(e(), once.id)).toHaveLength(0);
    expect(await e().audit.audit.verifyChain(once.id)).toEqual({ ok: true });
  }, 60_000);

  it('a started relay keeps going through the outage and catches up when Postgres returns', async () => {
    const audit = switchableAudit(e().audit.audit, downAudit(e()));
    const r = relay(e(), m(), { orgs: [looping.id], audit });
    r.start();
    const outbox = new (m().AuditOutbox)(e().graph);
    try {
      for (let n = 1; n <= 4; n++) await writeRisk(outbox, looping.id, n);
      // Let the relay try, and fail, for a few cycles.
      await waitFor('the relay to try the down Postgres at least twice', async () => audit.failures >= 2, 15_000);
      expect(await auditRows(e(), looping.id)).toHaveLength(0);
      expect(await outboxNodes(e(), looping.id)).toHaveLength(4);

      audit.up = true;
      await waitFor(
        'the waiting entries in Postgres',
        async () => (await auditRows(e(), looping.id)).length >= 4,
        10_000,
      );
      await waitFor('the outbox to empty', async () => (await outboxNodes(e(), looping.id)).length === 0, 10_000);
    } finally {
      await r.stop();
    }
    expect(ns(await auditRows(e(), looping.id))).toEqual([1, 2, 3, 4]);
    expect(await e().audit.audit.verifyChain(looping.id)).toEqual({ ok: true });
  }, 60_000);
});
