// M0-012 (D56, D72): the queue `audit.verify-chains` runs nightly in the worker program, checks
// every org's chain, and writes an `audit.chain_broken` event when one breaks.
// The worker runs against this file's throwaway database as grc_app (the M0-007 helpers).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  jobsServiceToken,
  prepareEnv,
  startWorker,
  waitFor,
  type JobsLike,
  type WorkerApp,
} from '../platform/helpers.js';
import {
  appendMany,
  column,
  newOrg,
  rows,
  setUpAudit,
  stored,
  tamper,
  tearDownAudit,
  type AuditEnv,
  type SeededOrg,
} from './helpers.js';

let env: AuditEnv | undefined;
let worker: WorkerApp | undefined;
let broken: SeededOrg;
let intact: SeededOrg;

function e(): AuditEnv {
  if (!env) throw new Error('set-up did not finish');
  return env;
}

function w(): WorkerApp {
  if (!worker) throw new Error('the worker did not start (see beforeAll)');
  return worker;
}

beforeAll(async () => {
  env = await setUpAudit();
  broken = await newOrg(env, 'Nightly Broken');
  intact = await newOrg(env, 'Nightly Intact');
  await appendMany(env, broken.id, 6);
  await appendMany(env, intact.id, 6);
  await tamper(env, broken.id, 4, `"${column(env, 'action')}" = 'x'`);
  prepareEnv(env.wall.dbName);
  worker = await startWorker();
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await tearDownAudit(env);
});

describe('the nightly chain check in the worker program', () => {
  it('schedules audit.verify-chains once a day', async () => {
    const { sql } = e().wall.loaded;
    const found = await waitFor(
      'the audit.verify-chains schedule',
      async () => {
        const r = await rows<{ cron: string }>(
          e().wall.sup,
          sql`SELECT cron FROM pgboss.schedule WHERE name = 'audit.verify-chains'`,
        );
        return r.length > 0 ? r : undefined;
      },
      30_000,
    );
    expect(found).toHaveLength(1);
    const fields = found[0]!.cron.trim().split(/\s+/);
    expect(fields, `cron '${found[0]!.cron}' has 5 fields`).toHaveLength(5);
    const [minute, hour, dom, month, dow] = fields;
    expect(minute).toMatch(/^\d{1,2}$/);
    expect(hour).toMatch(/^\d{1,2}$/);
    expect([dom, month, dow]).toEqual(['*', '*', '*']);
  }, 40_000);

  it('a run of the queue checks every org and flags only the broken chain', async () => {
    const jobs = w().get<JobsLike>(await jobsServiceToken());
    const id = await jobs.send('audit.verify-chains', {});
    expect(typeof id).toBe('string');
    const alerts = await waitFor(
      'an audit.chain_broken event in the broken org',
      async () => {
        const found = (await stored(e(), broken.id)).filter((r) => r.action === 'audit.chain_broken');
        return found.length > 0 ? found : undefined;
      },
      60_000,
      250,
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.actorType).toBe('system');
    expect(JSON.stringify({ meta: alerts[0]!.meta, after: alerts[0]!.after })).toMatch(/"brokenAtSeq":4\b/);
    const intactRows = await stored(e(), intact.id);
    expect(intactRows.filter((r) => r.action === 'audit.chain_broken')).toEqual([]);
    expect(intactRows).toHaveLength(6);
  }, 90_000);
});
