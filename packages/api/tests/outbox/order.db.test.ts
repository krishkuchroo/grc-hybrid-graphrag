// M0-013 criterion 4 (D37, D56): entries reach Postgres in the order they were written, per org.
// Writes follow each other quickly, so several can share a millisecond; the order must still hold.
// A failed append never lets a later entry of the same org overtake it.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  auditRows,
  loadOutbox,
  newOutboxOrg,
  ns,
  outboxNodes,
  relay,
  setUpOutbox,
  settle,
  tearDownOutbox,
  waitFor,
  writeRisk,
  type AuditServiceLike,
  type OutboxEnv,
  type OutboxModules,
  type SeededOrg,
} from './helpers.js';

let env: OutboxEnv | undefined;
let mods: OutboxModules | Error | undefined;
let one: SeededOrg;
let a: SeededOrg;
let b: SeededOrg;
let live: SeededOrg;
let stuck: SeededOrg;
let other: SeededOrg;

function e(): OutboxEnv {
  if (!env) throw new Error('set-up did not finish');
  return env;
}

function m(): OutboxModules {
  if (mods instanceof Error) throw mods;
  if (!mods) throw new Error('set-up did not finish');
  return mods;
}

const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

beforeAll(async () => {
  env = await setUpOutbox();
  one = await newOutboxOrg(env, 'Order One');
  a = await newOutboxOrg(env, 'Order A');
  b = await newOutboxOrg(env, 'Order B');
  live = await newOutboxOrg(env, 'Order Live');
  stuck = await newOutboxOrg(env, 'Order Stuck');
  other = await newOutboxOrg(env, 'Order Other');
  // A missing file fails each test (not the set-up), naming the file.
  mods = await loadOutbox().catch((err: unknown) => err as Error);
}, LONG);

afterAll(async () => {
  await tearDownOutbox(env);
}, LONG);

describe('the relay keeps the write order per org', () => {
  it('30 back-to-back writes reach Postgres in the order they were written', async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    for (const n of range(1, 30)) await writeRisk(outbox, one.id, n);

    await relay(e(), m(), { orgs: [one.id] }).runOnce();

    const found = await auditRows(e(), one.id);
    expect(ns(found)).toEqual(range(1, 30));
    expect(found.map((r) => r.seq)).toEqual(range(1, 30));
  }, 120_000);

  it('writes interleaved across two orgs keep each org in its own order', async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    for (const n of range(1, 15)) {
      await writeRisk(outbox, a.id, n);
      await writeRisk(outbox, b.id, 100 + n);
    }

    await relay(e(), m(), { orgs: [b.id, a.id] }).runOnce();

    expect(ns(await auditRows(e(), a.id))).toEqual(range(1, 15));
    expect(ns(await auditRows(e(), b.id))).toEqual(range(101, 115));
  }, 120_000);

  it('writes made while the relay is running keep their order across passes', async () => {
    const r = relay(e(), m(), { orgs: [live.id], intervalMs: 200 });
    r.start();
    const outbox = new (m().AuditOutbox)(e().graph);
    try {
      for (const n of range(1, 20)) {
        await writeRisk(outbox, live.id, n);
        if (n % 4 === 0) await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await waitFor('all 20 entries in Postgres', async () => (await auditRows(e(), live.id)).length >= 20, 20_000);
    } finally {
      await r.stop();
    }
    expect(ns(await auditRows(e(), live.id))).toEqual(range(1, 20));
  }, 60_000);

  it('if an append fails, later entries of that org wait for it instead of overtaking it', async () => {
    const outbox = new (m().AuditOutbox)(e().graph);
    for (const n of range(1, 4)) await writeRisk(outbox, stuck.id, n);
    for (const n of range(1, 2)) await writeRisk(outbox, other.id, 200 + n);

    const real = e().audit.audit;
    let failFirstOfStuck = true;
    const flaky: Pick<AuditServiceLike, 'append'> = {
      append: (ev) => {
        const n = Number((ev.meta as { n?: unknown } | undefined)?.n);
        if (ev.orgId === stuck.id && n === 1 && failFirstOfStuck) {
          failFirstOfStuck = false;
          return Promise.reject(new Error('transient Postgres error on purpose'));
        }
        return real.append(ev);
      },
    };

    await settle(relay(e(), m(), { orgs: [stuck.id, other.id], audit: flaky }).runOnce());

    expect(await auditRows(e(), stuck.id), 'no later entry overtook the failed one').toHaveLength(0);
    expect(await outboxNodes(e(), stuck.id), 'every entry of the org is still waiting').toHaveLength(4);
    expect(ns(await auditRows(e(), other.id)), 'the other org was not held up').toEqual([201, 202]);

    await relay(e(), m(), { orgs: [stuck.id, other.id], audit: flaky }).runOnce();

    expect(ns(await auditRows(e(), stuck.id))).toEqual([1, 2, 3, 4]);
    expect(await outboxNodes(e(), stuck.id)).toHaveLength(0);
  }, 60_000);
});
