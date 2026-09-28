// M0-013 criterion 2 in the real program (D36, D37, D48): the worker program runs the outbox
// relay, so a change saved through withAuditedWrite reaches the Postgres audit trail within 5 s
// while the worker runs. The worker runs against this file's throwaway database as grc_app, and
// against Neo4j Desktop as the writer account (the M0-007 helpers).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareEnv, startWorker, type WorkerApp } from '../platform/helpers.js';
import {
  LONG,
  auditRows,
  loadOutbox,
  newOutboxOrg,
  outboxNodes,
  setUpOutbox,
  tearDownOutbox,
  waitFor,
  writeRisk,
  type OutboxEnv,
  type OutboxModules,
  type SeededOrg,
} from './helpers.js';

let env: OutboxEnv | undefined;
let mods: OutboxModules | Error | undefined;
let worker: WorkerApp | undefined;
let first: SeededOrg;
let second: SeededOrg;

function e(): OutboxEnv {
  if (!env) throw new Error('set-up did not finish');
  return env;
}

function m(): OutboxModules {
  if (mods instanceof Error) throw mods;
  if (!mods) throw new Error('set-up did not finish');
  return mods;
}

function w(): WorkerApp {
  if (!worker) throw new Error('the worker did not start (see beforeAll)');
  return worker;
}

beforeAll(async () => {
  env = await setUpOutbox();
  first = await newOutboxOrg(env, 'Worker Relay One');
  second = await newOutboxOrg(env, 'Worker Relay Two');
  prepareEnv(env.audit.wall.dbName);
  worker = await startWorker();
  // A missing file fails each test (not the set-up), naming the file.
  mods = await loadOutbox().catch((err: unknown) => err as Error);
}, LONG);

afterAll(async () => {
  await worker?.close();
  await tearDownOutbox(env);
}, LONG);

describe('the worker program relays the audit outbox', () => {
  it('a write in each org reaches Postgres within 5 s, and its outbox node is deleted', async () => {
    w();
    const outbox = new (m().AuditOutbox)(e().graph);
    for (const org of [first, second]) {
      await writeRisk(outbox, org.id, 1);
      const saved = Date.now();
      await waitFor(
        `the audit row of org ${org.name}`,
        async () => (await auditRows(e(), org.id)).length >= 1,
        5_000,
        50,
      );
      expect(Date.now() - saved).toBeLessThan(5_000);
      expect(await auditRows(e(), org.id)).toHaveLength(1);
      await waitFor('the outbox node to be deleted', async () => (await outboxNodes(e(), org.id)).length === 0, 5_000);
    }
  }, 60_000);
});
