// M0-007 criterion 7 (D29, D36, D45.5, D72), against a throwaway database.
// 7. The worker program starts pg-boss and the API program doesn't process jobs. A job that throws is
//    retried 3 times with growing waits, then lands in the failed state. Sending the same
//    singletonKey twice queues one job.
//
// The retry test doesn't sit through the real waits: each time a job goes into `retry`, it records the
// wait pg-boss chose (start_after - started_on; the handler throws at once) and then moves start_after
// to now(), as the superuser, so the next attempt comes at the next poll.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  jobsServiceToken,
  platformDb,
  startApi,
  startWorker,
  waitFor,
  type ApiApp,
  type JobsLike,
  type PlatformDb,
  type WorkerApp,
} from './helpers.js';

let db: PlatformDb | undefined;
let worker: WorkerApp | undefined;
let api: ApiApp | undefined;
let workerJobs: JobsLike | undefined;
let apiJobs: JobsLike | undefined;

beforeAll(async () => {
  db = await platformDb();
  const token = await jobsServiceToken();
  worker = await startWorker();
  workerJobs = worker.get<JobsLike>(token);
  api = await startApi();
  apiJobs = api.get<JobsLike>(token);
}, 180_000);

afterAll(async () => {
  await api?.close();
  await worker?.close();
  await db?.drop();
});

function need<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`${what} did not start (see beforeAll)`);
  return value;
}

interface JobRow {
  state: string;
  retry_limit: number;
  retry_backoff: boolean;
  retry_delay: number;
  delay: number | null;
}

async function jobRow(id: string): Promise<JobRow | undefined> {
  const rows = await need(db, 'the database').query<JobRow>(
    `select state, retry_limit, retry_backoff, retry_delay,
            extract(epoch from (start_after - started_on))::float8 as delay
       from pgboss.job where id = $1`,
    [id],
  );
  return rows[0];
}

const queue = (name: string) => `platform-test-${name}-${randomUUID().slice(0, 8)}`;

describe('criterion 7: the worker program processes jobs', () => {
  it('runs a job to completion', async () => {
    const jobs = need(workerJobs, 'the worker');
    const q = queue('ok');
    const seen: unknown[] = [];
    await jobs.work(q, async (job) => {
      seen.push(job.data);
    });
    const id = await jobs.send(q, { hello: 'worker' });
    expect(typeof id).toBe('string');
    await waitFor('the job to run', async () => seen.length > 0, 30_000);
    expect(seen).toEqual([{ hello: 'worker' }]);
    await waitFor('the job to be completed', async () => (await jobRow(id!))?.state === 'completed', 30_000);
  });

  it('processes a job the API program sent', async () => {
    const q = queue('from-api');
    const seen: unknown[] = [];
    await need(workerJobs, 'the worker').work(q, async (job) => {
      seen.push(job.data);
    });
    const id = await need(apiJobs, 'the API').send(q, { from: 'api' });
    expect(typeof id).toBe('string');
    await waitFor('the worker to run the API job', async () => seen.length > 0, 30_000);
    expect(seen).toEqual([{ from: 'api' }]);
  });
});

describe("criterion 7: the API program doesn't process jobs", () => {
  it('refuses to register a job handler', async () => {
    const jobs = need(apiJobs, 'the API');
    let ran = false;
    await expect(
      jobs.work(queue('api-work'), async () => {
        ran = true;
      }),
    ).rejects.toThrow();
    expect(ran).toBe(false);
  });
});

describe('criterion 7: D72 retries', () => {
  it('sends jobs with 3 retries and growing waits by default', async () => {
    const id = await need(apiJobs, 'the API').send(queue('defaults'), { n: 1 });
    const row = await jobRow(id!);
    expect(row, 'the job row').toBeDefined();
    expect(row!.retry_limit).toBe(3);
    expect(row!.retry_backoff).toBe(true);
    expect(row!.retry_delay).toBeGreaterThan(0);
  });

  it('retries a failing job 3 times with growing waits, then leaves it failed', async () => {
    const jobs = need(workerJobs, 'the worker');
    const q = queue('fail');
    let calls = 0;
    await jobs.work(q, async () => {
      calls++;
      throw new Error('platform test: this job always fails');
    });
    const id = await jobs.send(q, { n: 1 });
    expect(typeof id).toBe('string');

    const waits: number[] = [];
    await waitFor(
      'the job to fail for good',
      async () => {
        const row = await jobRow(id!);
        if (!row) return false;
        if (row.state === 'failed') return true;
        if (row.state === 'retry' && calls === waits.length + 1) {
          waits.push(Number(row.delay));
          await need(db, 'the database').query(`update pgboss.job set start_after = now() where id = $1`, [id]);
        }
        return false;
      },
      120_000,
      50,
    );

    expect(calls, 'attempts: the first run plus 3 retries').toBe(4);
    expect(waits).toHaveLength(3);
    expect(waits[0]!).toBeGreaterThan(0);
    expect(waits[1]!).toBeGreaterThanOrEqual(waits[0]!);
    expect(waits[2]!).toBeGreaterThanOrEqual(waits[1]!);
    expect(waits[2]!).toBeGreaterThan(waits[0]!);

    // It stays failed (kept for the failed-jobs list), and no fifth attempt comes.
    await new Promise((r) => setTimeout(r, 3_000));
    expect((await jobRow(id!))?.state).toBe('failed');
    expect(calls).toBe(4);
  }, 150_000);
});

describe('criterion 7: job keys prevent duplicates', () => {
  it('queues one job when the same singletonKey is sent twice', async () => {
    const jobs = need(apiJobs, 'the API');
    const q = queue('single');
    const first = await jobs.send(q, { n: 1 }, { singletonKey: 'sha256:abc' });
    const second = await jobs.send(q, { n: 2 }, { singletonKey: 'sha256:abc' });
    expect(typeof first).toBe('string');
    expect(second).toBeNull();
    const rows = await need(db, 'the database').query<{ n: number }>(
      `select count(*)::int as n from pgboss.job where name = $1`,
      [q],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('queues both when the keys differ', async () => {
    const jobs = need(apiJobs, 'the API');
    const q = queue('two-keys');
    expect(typeof (await jobs.send(q, { n: 1 }, { singletonKey: 'chunk:1' }))).toBe('string');
    expect(typeof (await jobs.send(q, { n: 2 }, { singletonKey: 'chunk:2' }))).toBe('string');
    const rows = await need(db, 'the database').query<{ n: number }>(
      `select count(*)::int as n from pgboss.job where name = $1`,
      [q],
    );
    expect(rows[0]!.n).toBe(2);
  });
});
