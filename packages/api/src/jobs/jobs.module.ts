// Background jobs through pg-boss (D29, D72). Both programs can send jobs; only the worker
// program processes them (D36). pg-boss's tables come from the migrations (0001_pgboss.sql),
// because grc_app can create nothing (D57), so pg-boss starts with migrate and createSchema off.
//
// D72 defaults: 3 retries with growing waits, then the job stays in the failed state (the
// failed-jobs list). Job keys (content hash or chunk ID) mean the same job is never queued twice:
// queues use pg-boss's `exclusive` policy, which allows one queued-or-running job per key. A job
// sent without a key gets its own unique key, so it is never merged with another.
//
// Handlers are told which try they're on and whether it's the last (S4-002), so a step can mark
// its work failed before the job goes to the failed-jobs list. A job can be queued to start after a
// delay (`startAfterSeconds`), and a handler can stop and have its job run again later without
// using up a try, by throwing `RunLater` (S4-002, D45.7: a step waits while Ollama is down). The
// job is then done and a fresh copy, with the same data and key, is queued to start after the
// delay, in one transaction, so the work is never lost and never doubled.
import { randomUUID } from 'node:crypto';
import { Logger, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { fromDrizzle, PgBoss, type Db as BossDb, type JobWithMetadata } from 'pg-boss';
import type { Tx } from '../db/org-context.js';

export const JOB_DEFAULTS = Object.freeze({
  retryLimit: 3,
  retryBackoff: true,
  /** Seconds before the first retry; later waits grow from it (pg-boss's exponential backoff). */
  retryDelay: 30,
});

const QUEUE_POLICY = 'exclusive';

/** The longest a job can be put off: one day. */
export const MAX_JOB_DELAY_SECONDS = 86_400;

export interface JobsOptions {
  connectionString: string;
  /** True in the worker program only. */
  processJobs: boolean;
}

export interface SendOptions {
  /** The job key: a job with the same key already queued or running means this one isn't queued. */
  singletonKey?: string;
  /** Seconds to wait before the job may start, up to `MAX_JOB_DELAY_SECONDS`; it may start now when not given. */
  startAfterSeconds?: number;
}

export interface JobHandlerInput {
  id: string;
  data: unknown;
  /** Which try this is, from 1. */
  attempt: number;
  /** How many tries the job has in all: the first, plus D72's retries. */
  attempts: number;
  /** True on the job's last try: if this one fails, the job goes to the failed-jobs list. */
  isLastAttempt: boolean;
}

// A whole number of seconds from 1 to MAX_JOB_DELAY_SECONDS (a fraction rounds up).
function checkDelay(seconds: number): number {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error('a job delay must be a positive number of seconds');
  }
  const whole = Math.ceil(seconds);
  if (whole > MAX_JOB_DELAY_SECONDS) throw new Error(`a job delay is at most ${MAX_JOB_DELAY_SECONDS} seconds`);
  return whole;
}

/**
 * Thrown by a job handler to stop now and run the same job again after `delaySeconds`, without
 * using up a try (D45.7: a step waits while Ollama is down). What the handler did before throwing
 * must be safe to do again (D45.5), because the copy starts the job from the beginning.
 */
export class RunLater extends Error {
  readonly delaySeconds: number;

  constructor(delaySeconds: number, reason = 'run later') {
    super(reason);
    this.name = 'RunLater';
    this.delaySeconds = checkDelay(delaySeconds);
  }
}

/** What a handler is told about the try it's on, from pg-boss's retry count and limit. */
export function attemptOf(job: Pick<JobWithMetadata, 'retryCount' | 'retryLimit'>): {
  attempt: number;
  attempts: number;
  isLastAttempt: boolean;
} {
  const retryLimit = Math.max(0, job.retryLimit);
  const retryCount = Math.max(0, job.retryCount);
  return { attempt: retryCount + 1, attempts: retryLimit + 1, isLastAttempt: retryCount >= retryLimit };
}

interface BossSendOptions {
  retryLimit: number;
  retryBackoff: boolean;
  retryDelay: number;
  singletonKey: string;
  startAfter?: number;
}

// pg-boss's send options for ours: D72's retries, the key (or a unique one) and the delay.
function sendOptions(opts: SendOptions): BossSendOptions {
  const options: BossSendOptions = { ...JOB_DEFAULTS, singletonKey: opts.singletonKey ?? randomUUID() };
  if (opts.startAfterSeconds !== undefined) options.startAfter = checkDelay(opts.startAfterSeconds);
  return options;
}

export class JobsService implements OnApplicationShutdown {
  private readonly boss: PgBoss;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly log = new Logger('Jobs');
  // A small pool of our own for `RunLater`'s one transaction (pg-boss keeps its pool to itself);
  // made the first time a handler runs later, so only in the worker program.
  private laterPool: Pool | null = null;

  constructor(private readonly options: JobsOptions) {
    this.boss = new PgBoss({
      connectionString: options.connectionString,
      schema: 'pgboss',
      migrate: false,
      createSchema: false,
      // Maintenance and schedules run in the worker only.
      supervise: options.processJobs,
      schedule: options.processJobs,
    });
    this.boss.on('error', (err: unknown) => this.log.error(err));
  }

  async start(): Promise<this> {
    await this.boss.start();
    return this;
  }

  /**
   * Queues a job. Returns its ID, or null when a job with the same key is already queued or running.
   * With `startAfterSeconds` it waits that long before it may start.
   */
  async send(queue: string, data: object, opts: SendOptions = {}): Promise<string | null> {
    const options = sendOptions(opts);
    await this.ensureQueue(queue);
    return this.boss.send(queue, data, options);
  }

  /**
   * Queues a job inside the caller's transaction (D29), through pg-boss's `db` option, so the job
   * exists only if that transaction commits. Same defaults, key rule and delay as `send`; returns
   * the ID, or null when a job with the same key is already queued or running (the same key twice
   * in one transaction too). The queue itself is created outside the transaction, once per queue.
   */
  async sendInTx(tx: Tx, queue: string, data: object, opts: SendOptions = {}): Promise<string | null> {
    const options = sendOptions(opts);
    await this.ensureQueue(queue);
    return this.boss.send(queue, data, { ...options, db: fromDrizzle(tx, sql) });
  }

  /**
   * Registers a handler for a queue. Only the worker program processes jobs. `concurrency` is how
   * many jobs of the queue this program runs at once (D72: read file ×4, embed ×2 …), 1 by default.
   * The handler is told which try it's on and whether it's the last; a `RunLater` it throws puts
   * the job off without using up a try, and any other error is a failed try (D72).
   */
  async work(
    queue: string,
    handler: (job: JobHandlerInput) => Promise<void>,
    opts: { concurrency?: number } = {},
  ): Promise<void> {
    if (!this.options.processJobs) {
      throw new Error('The API program does not process jobs; register job handlers in the worker.');
    }
    const concurrency = opts.concurrency ?? 1;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error('work: concurrency must be a whole number from 1');
    }
    await this.ensureQueue(queue);
    await this.boss.work(
      queue,
      { batchSize: 1, localConcurrency: concurrency, includeMetadata: true },
      async (jobs: JobWithMetadata[]) => {
        for (const job of jobs) {
          try {
            await handler({ id: job.id, data: job.data, ...attemptOf(job) });
          } catch (err) {
            if (!(err instanceof RunLater)) throw err;
            await this.runLater(queue, job, err.delaySeconds);
          }
        }
      },
    );
  }

  /** True in the worker program, the only one that processes jobs and runs schedules. */
  get processesJobs(): boolean {
    return this.options.processJobs;
  }

  /** Schedules a queue on a cron expression (UTC). Only the worker program runs schedules. */
  async schedule(queue: string, cron: string, data: object = {}): Promise<void> {
    if (!this.options.processJobs) {
      throw new Error('The API program does not run schedules; schedule jobs in the worker.');
    }
    await this.ensureQueue(queue);
    await this.boss.schedule(queue, cron, data);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
    const pool = this.laterPool;
    this.laterPool = null;
    if (pool) await pool.end();
  }

  // Ends this try of the job and queues a fresh copy (same data, same key, all its tries) to start
  // after the delay, in one transaction: the exclusive key is free for the copy only once this job
  // is done, and neither change happens without the other. pg-boss's own completion afterwards
  // finds the job already done and leaves it. If the transaction fails, the error fails this try
  // (D72). The log line names only the job, the queue and the delay.
  private async runLater(queue: string, job: JobWithMetadata, delaySeconds: number): Promise<void> {
    this.laterPool ??= new Pool({ connectionString: this.options.connectionString, max: 2 });
    const client = await this.laterPool.connect();
    const db: BossDb = { executeSql: (text, values) => client.query(text, values) };
    try {
      await client.query('BEGIN');
      await this.boss.complete(queue, { id: job.id, retryCount: job.retryCount }, null, { db });
      await this.boss.send(queue, job.data, {
        ...sendOptions({ singletonKey: job.singletonKey ?? undefined, startAfterSeconds: delaySeconds }),
        db,
      });
      await client.query('COMMIT');
      this.log.log(`job ${job.id} on ${queue} put off for ${delaySeconds}s`);
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  private ensureQueue(queue: string): Promise<void> {
    let created = this.queues.get(queue);
    if (!created) {
      created = this.boss.createQueue(queue, { policy: QUEUE_POLICY, ...JOB_DEFAULTS });
      created.catch(() => this.queues.delete(queue));
      this.queues.set(queue, created);
    }
    return created;
  }
}

function jobsProvider(processJobs: boolean) {
  return {
    provide: JobsService,
    useFactory: async (): Promise<JobsService> => {
      const connectionString = process.env.DATABASE_URL_APP;
      if (!connectionString) throw new Error('DATABASE_URL_APP is not set');
      return new JobsService({ connectionString, processJobs }).start();
    },
  };
}

export class JobsModule {
  /** The API program: sends jobs, never processes them. */
  static forApi(): DynamicModule {
    return { module: JobsModule, global: true, providers: [jobsProvider(false)], exports: [JobsService] };
  }

  /** The worker program: sends and processes jobs. */
  static forWorker(): DynamicModule {
    return { module: JobsModule, global: true, providers: [jobsProvider(true)], exports: [JobsService] };
  }
}
Module({})(JobsModule);
