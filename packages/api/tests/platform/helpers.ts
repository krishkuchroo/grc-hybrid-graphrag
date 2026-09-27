// Shared set-up for the M0-007 platform tests (D28, D29, D30, D36, D45, D46, D47, D64, D72).
//
// Contract these tests hold the builder to:
// - `src/main.api.ts` exports
//     `createApiApp(opts?: { imports?: unknown[]; logStream?: { write(line: string): void } })`
//   which builds the API program (NestJS on the Fastify adapter) with every protection on, runs
//   `init()`, and returns the NestFastifyApplication WITHOUT listening on a port. The tests call
//   `app.inject(...)` and `app.close()`. `imports` are extra Nest modules mounted next to AppModule
//   (the tests add one small controller); `logStream` is where pino writes its JSON lines.
//   Running the file directly (`node dist/main.api.js`) is what starts listening; importing it
//   must not.
// - `src/main.worker.ts` exports `createWorkerApp(opts?: { logStream?: ... })`, which builds the
//   worker program (WorkerModule), starts pg-boss and returns the Nest application context.
// - `src/jobs/jobs.module.ts` exports `JobsService` (defined there or re-exported), reachable with
//   `app.get(JobsService)` in both programs:
//     `send(queue, data, { singletonKey? }): Promise<string | null>` returns the job ID, or null
//        when a job with the same singletonKey is already queued. It creates the queue if needed.
//     `work(queue, handler: (job: { id: string; data: unknown }) => Promise<void>): Promise<void>`
//        registers a handler. Only the worker program processes jobs: in the API program it rejects.
// - pg-boss keeps its tables in the `pgboss` schema (its default).
// - `src/common/paging.ts` exports `pageQuerySchema` (Zod) and the `Paged<T>` type.
// - `src/health/health.controller.ts` exports `healthResponseSchema` (Zod object).
//
// Database: every test file gets its own throwaway Postgres database (D82), created and migrated
// by `drizzle-kit migrate` as grc_migrator (reusing the M0-003 helpers). The apps then run with
// DATABASE_URL_APP pointed at it, so they connect as the restricted grc_app account (D57). grc_app
// can create nothing, so pg-boss's schema has to come from the migrations.
// Neo4j and the S3 service key come from `.env` (Neo4j Desktop on 127.0.0.1:7687, SeaweedFS on the
// dev switch at 127.0.0.1:8333). DATABASE_URL_MIGRATE and the superuser password are never put in
// the environment the apps see.
import 'reflect-metadata';
import { Body, Controller, Get, Module, Post, Query } from '@nestjs/common';
import pg from 'pg';
import { expect } from 'vitest';
import {
  appUrl,
  createThrowaway,
  dropThrowaway,
  load,
  migrateUrl,
  runMigrations,
  setting,
  superUrl,
  type Loaded,
} from '../db/helpers.js';

export const PREFIX = '/api/v1';
export const TEST_ROUTES = `${PREFIX}/platform-test`;
export const SECRET_DETAIL = 'platform-test-internal-detail-7f3a';

// ---------- apps under test ----------

export interface InjectResponse {
  statusCode: number;
  headers: Record<string, string | string[] | number | undefined>;
  body: string;
  json(): unknown;
}

export interface InjectOptions {
  method?: string;
  url: string;
  headers?: Record<string, string>;
  payload?: string | Buffer | object;
  remoteAddress?: string;
}

export interface ApiApp {
  inject(opts: InjectOptions): Promise<InjectResponse>;
  get<T = unknown>(token: unknown): T;
  close(): Promise<void>;
}

export interface WorkerApp {
  get<T = unknown>(token: unknown): T;
  close(): Promise<void>;
}

export interface JobsLike {
  send(queue: string, data: object, opts?: { singletonKey?: string }): Promise<string | null>;
  work(queue: string, handler: (job: { id: string; data: unknown }) => Promise<void>): Promise<void>;
}

export class LogCapture {
  lines: string[] = [];
  write(line: string): void {
    this.lines.push(String(line));
  }
}

export async function startApi(opts: { imports?: unknown[]; logStream?: LogCapture } = {}): Promise<ApiApp> {
  const mod = (await import('../../src/main.api.js')) as { createApiApp?: (o: unknown) => Promise<ApiApp> };
  if (typeof mod.createApiApp !== 'function') throw new Error('src/main.api.ts must export createApiApp');
  return mod.createApiApp(opts);
}

export async function startWorker(opts: { logStream?: LogCapture } = {}): Promise<WorkerApp> {
  const mod = (await import('../../src/main.worker.js')) as {
    createWorkerApp?: (o: unknown) => Promise<WorkerApp>;
  };
  if (typeof mod.createWorkerApp !== 'function') throw new Error('src/main.worker.ts must export createWorkerApp');
  return mod.createWorkerApp(opts);
}

export async function jobsServiceToken(): Promise<unknown> {
  const mod = (await import('../../src/jobs/jobs.module.js')) as { JobsService?: unknown };
  if (typeof mod.JobsService !== 'function') throw new Error('src/jobs/jobs.module.ts must export JobsService');
  return mod.JobsService;
}

// ---------- a small test controller, mounted under the global prefix ----------
// Decorators are applied as plain calls, so this file needs no decorator syntax.

type PageQuerySchema = { parse(input: unknown): unknown };

export async function testModule(): Promise<unknown> {
  const paging = (await import('../../src/common/paging.js')) as { pageQuerySchema?: PageQuerySchema };
  const schema = paging.pageQuerySchema;
  if (!schema) throw new Error('src/common/paging.ts must export pageQuerySchema');

  class PlatformTestController {
    ok(): { ok: true } {
      return { ok: true };
    }
    boom(): never {
      throw new Error(`${SECRET_DETAIL}: something broke inside`);
    }
    echo(body: unknown): { bytes: number } {
      return { bytes: JSON.stringify(body).length };
    }
    page(query: unknown): unknown {
      return schema!.parse(query);
    }
  }
  const proto = PlatformTestController.prototype;
  const desc = (name: keyof PlatformTestController) => Object.getOwnPropertyDescriptor(proto, name)!;
  Controller('platform-test')(PlatformTestController);
  Get('ok')(proto, 'ok', desc('ok'));
  Get('boom')(proto, 'boom', desc('boom'));
  Post('echo')(proto, 'echo', desc('echo'));
  Body()(proto, 'echo', 0);
  Get('page')(proto, 'page', desc('page'));
  Query()(proto, 'page', 0);

  class PlatformTestModule {}
  Module({ controllers: [PlatformTestController] })(PlatformTestModule);
  return PlatformTestModule;
}

// ---------- environment and throwaway database ----------

function optional(name: string): string | undefined {
  try {
    return setting(name);
  } catch {
    return undefined;
  }
}

export function prepareEnv(database: string): void {
  process.env.DATABASE_URL_APP = appUrl(database);
  for (const name of ['NEO4J_ADMIN_PASSWORD', 'NEO4J_WRITER_PASSWORD', 'S3_ACCESS_KEY', 'S3_SECRET_KEY']) {
    const value = optional(name);
    if (value && !process.env[name]) process.env[name] = value;
  }
  process.env.NEO4J_URI ||= 'bolt://127.0.0.1:7687';
  process.env.S3_ENDPOINT ||= 'http://127.0.0.1:8333';
  delete process.env.DATABASE_URL_MIGRATE;
}

export interface PlatformDb {
  name: string;
  loaded: Loaded;
  drop(): Promise<void>;
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
}

// Creates and migrates a throwaway database, and points the apps at it.
export async function platformDb(): Promise<PlatformDb> {
  const loaded = await load();
  const name = await createThrowaway(loaded);
  const migrated = await runMigrations(migrateUrl(name));
  if (!migrated.ok) {
    await dropThrowaway(loaded, name);
    throw new Error(`Test set-up: migrations failed\n${migrated.output}`);
  }
  prepareEnv(name);
  return {
    name,
    loaded,
    drop: () => dropThrowaway(loaded, name),
    // Superuser queries, for reading pg-boss's tables from outside the apps.
    async query<T>(text: string, params: unknown[] = []): Promise<T[]> {
      const client = new pg.Client({ connectionString: superUrl(name) });
      await client.connect();
      try {
        return (await client.query(text, params)).rows as T[];
      } finally {
        await client.end();
      }
    },
  };
}

// ---------- assertions ----------

export interface ErrorBody {
  error: { code: string; message: string; referenceId: string };
}

// D47: one error format, with a reference ID.
export function expectErrorFormat(res: InjectResponse, status: number): ErrorBody {
  expect(res.statusCode, `status (body: ${res.body.slice(0, 300)})`).toBe(status);
  expect(String(res.headers['content-type'] ?? '')).toMatch(/application\/json/);
  const body = JSON.parse(res.body) as ErrorBody;
  expect(Object.keys(body)).toEqual(['error']);
  expect(typeof body.error.code).toBe('string');
  expect(body.error.code.length).toBeGreaterThan(0);
  expect(typeof body.error.message).toBe('string');
  expect(body.error.message.length).toBeGreaterThan(0);
  expect(typeof body.error.referenceId).toBe('string');
  expect(body.error.referenceId.length).toBeGreaterThan(0);
  return body;
}

export async function waitFor<T>(
  what: string,
  fn: () => Promise<T | undefined | null | false>,
  timeoutMs = 60_000,
  everyMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeoutMs} ms waiting for ${what}`);
    await new Promise((r) => setTimeout(r, everyMs));
  }
}
