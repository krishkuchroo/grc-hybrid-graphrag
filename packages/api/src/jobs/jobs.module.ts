// Background jobs through pg-boss (D29, D72). Both programs can send jobs; only the worker
// program processes them (D36). pg-boss's tables come from the migrations (0001_pgboss.sql),
// because grc_app can create nothing (D57), so pg-boss starts with migrate and createSchema off.
//
// D72 defaults: 3 retries with growing waits, then the job stays in the failed state (the
// failed-jobs list). Job keys (content hash or chunk ID) mean the same job is never queued twice:
// queues use pg-boss's `exclusive` policy, which allows one queued-or-running job per key. A job
// sent without a key gets its own unique key, so it is never merged with another.
import { randomUUID } from 'node:crypto';
import { Logger, Module, type DynamicModule, type OnApplicationShutdown } from '@nestjs/common';
import { PgBoss } from 'pg-boss';

export const JOB_DEFAULTS = Object.freeze({
  retryLimit: 3,
  retryBackoff: true,
  /** Seconds before the first retry; later waits grow from it (pg-boss's exponential backoff). */
  retryDelay: 30,
});

const QUEUE_POLICY = 'exclusive';

export interface JobsOptions {
  connectionString: string;
  /** True in the worker program only. */
  processJobs: boolean;
}

export interface JobHandlerInput {
  id: string;
  data: unknown;
}

export class JobsService implements OnApplicationShutdown {
  private readonly boss: PgBoss;
  private readonly queues = new Map<string, Promise<void>>();
  private readonly log = new Logger('Jobs');

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

  /** Queues a job. Returns its ID, or null when a job with the same key is already queued or running. */
  async send(queue: string, data: object, opts: { singletonKey?: string } = {}): Promise<string | null> {
    await this.ensureQueue(queue);
    return this.boss.send(queue, data, { ...JOB_DEFAULTS, singletonKey: opts.singletonKey ?? randomUUID() });
  }

  /** Registers a handler for a queue. Only the worker program processes jobs. */
  async work(queue: string, handler: (job: JobHandlerInput) => Promise<void>): Promise<void> {
    if (!this.options.processJobs) {
      throw new Error('The API program does not process jobs; register job handlers in the worker.');
    }
    await this.ensureQueue(queue);
    await this.boss.work(queue, { batchSize: 1 }, async (jobs) => {
      for (const job of jobs) await handler({ id: job.id, data: job.data });
    });
  }

  async onApplicationShutdown(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 10_000 });
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
