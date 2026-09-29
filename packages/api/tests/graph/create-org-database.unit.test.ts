// S1-014 criterion 1: a new org database that fails to start fails at once (D217).
// Decisions: D217 (fail at once, naming the database and its state; no retries), D171 (no retries,
// no sleeps as waits), M0-004 (`org-<orgId>` names, the admin account makes databases in `system`,
// re-running is safe: an existing online database is a no-op), D57 and D164 (no secret values in
// errors).
//
// Contract:
// - `GraphService.createOrgDatabase(orgId)` in packages/api/src/graph/graph.service.ts runs
//   `CREATE DATABASE $name IF NOT EXISTS WAIT` once in `system` as grc_admin, reads its result rows
//   (Neo4j's WAIT result: `address`, `state`, `message`, `success`) and then
//   `SHOW DATABASE $name YIELD currentStatus`.
// - A WAIT result that reports a failure (`success: false`), or a `currentStatus` other than
//   `online`, rejects straight away with `OrgDatabaseNotOnline` (`database`, `state`), its message
//   naming both. Only `starting` is checked again.
// - An `online` database resolves; `ExistingDatabaseFound` from the create, then `online`, resolves.
//
// No real Neo4j: `neo4j-driver` is mocked, and the admin driver's `system` session returns scripted
// rows. On the code before D217 the rejecting cases poll for 120 s (ONLINE_WAIT_MS) and hit this
// file's short test timeout, which is the red. No fake timers: a real wait would show as a timeout.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const ADMIN_PASSWORD = 'admin-pw-Zq81-never-print';
const WRITER_PASSWORD = 'writer-pw-Kx42-never-print';
const QUERY_SECRET = 'query-secret-Vb77-never-print';

const ORG_ID = '3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b';
const DB_NAME = `org-${ORG_ID}`;

// Far under ONLINE_WAIT_MS (120 s), and enough for a few 250 ms re-checks while `starting`.
const SETTLE_MS = 5_000;

type Row = Record<string, unknown>;
type Step = { rows: Row[] } | { error: Error & { code?: string } };

interface Call {
  user: string;
  database: string | undefined;
  query: string;
  params: unknown;
}

interface Script {
  create: Step;
  show: Step[];
  calls: Call[];
}

// Each test gets its own script and call list, bound to the drivers when the service is made, so a
// wait left running by one test (on code that still polls) can never read or record into another.
let script: Script = { create: { rows: [] }, show: [], calls: [] };
let calls: Call[] = script.calls;

function record(row: Row) {
  return {
    keys: Object.keys(row),
    get: (key: string) => {
      if (!(key in row)) throw new Error(`no field ${key}`);
      return row[key];
    },
    has: (key: string) => key in row,
    toObject: () => ({ ...row }),
  };
}

function answer(step: Step | undefined) {
  if (!step) return Promise.reject(new Error('stub: no scripted answer left for SHOW DATABASE'));
  if ('error' in step) return Promise.reject(step.error);
  return Promise.resolve({ records: step.rows.map(record), summary: {} });
}

vi.mock('neo4j-driver', () => {
  const driver = (_uri: string, auth: { principal: string }) => {
    const mine = script;
    return {
      session: (config?: { database?: string }) => ({
        run: (query: string, params?: unknown) => {
          mine.calls.push({ user: auth.principal, database: config?.database, query, params });
          if (/^\s*CREATE DATABASE/i.test(query)) return answer(mine.create);
          if (/^\s*SHOW DATABASE/i.test(query)) return answer(mine.show.shift());
          return Promise.reject(new Error(`stub: unexpected query ${query}`));
        },
        close: () => Promise.resolve(),
      }),
      close: () => Promise.resolve(),
      verifyConnectivity: () => Promise.resolve(),
    };
  };
  const api = {
    driver,
    auth: { basic: (principal: string, credentials: string) => ({ scheme: 'basic', principal, credentials }) },
    session: { READ: 'READ', WRITE: 'WRITE' },
  };
  return { default: api, ...api };
});

const graphModule = await import('../../src/graph/graph.service.js');
const { GraphService } = graphModule;
// Read by name so this file typechecks before the builder adds the class (D217).
const OrgDatabaseNotOnline = (graphModule as Record<string, unknown>)['OrgDatabaseNotOnline'] as
  (abstract new (...args: never[]) => Error) | undefined;

function service() {
  return new GraphService({
    uri: 'bolt://127.0.0.1:1',
    adminPassword: ADMIN_PASSWORD,
    writerPassword: WRITER_PASSWORD,
    querySecret: QUERY_SECRET,
  });
}

const waitOk: Row = { address: '127.0.0.1:7687', state: 'CaughtUp', message: 'caught up', success: true };
const waitFailed: Row = {
  address: '127.0.0.1:7687',
  state: 'Failed',
  message: 'database_lock: the store is locked by another process',
  success: false,
};
const status = (currentStatus: string): Step => ({ rows: [{ currentStatus }] });

const createCalls = () => calls.filter((c) => /^\s*CREATE DATABASE/i.test(c.query));
const showCalls = () => calls.filter((c) => /^\s*SHOW DATABASE/i.test(c.query));

async function rejection(p: Promise<unknown>): Promise<Error & { database?: unknown; state?: unknown }> {
  try {
    await p;
  } catch (err) {
    return err as Error & { database?: unknown; state?: unknown };
  }
  throw new Error('createOrgDatabase resolved, but it should have rejected with OrgDatabaseNotOnline');
}

function expectNoSecrets(err: Error & { database?: unknown; state?: unknown }) {
  const text = [err.message, String(err.database), String(err.state), JSON.stringify(err)].join('\n');
  for (const secret of [ADMIN_PASSWORD, WRITER_PASSWORD, QUERY_SECRET]) {
    expect(text).not.toContain(secret);
  }
}

function expectNotOnline(err: Error & { database?: unknown; state?: unknown }, state: RegExp) {
  expect(OrgDatabaseNotOnline, 'graph.service.ts exports OrgDatabaseNotOnline').toBeTypeOf('function');
  expect(err).toBeInstanceOf(OrgDatabaseNotOnline as abstract new (...args: never[]) => Error);
  expect(err.database).toBe(DB_NAME);
  expect(typeof err.state).toBe('string');
  expect(err.state).toMatch(state);
  expect(err.message).toContain(DB_NAME);
  expect(err.message).toContain(err.state as string);
  expectNoSecrets(err);
}

function expectOneCreateInSystemAsAdmin() {
  const creates = createCalls();
  expect(creates).toHaveLength(1);
  expect(creates[0]?.database).toBe('system');
  expect(creates[0]?.user).toBe('grc_admin');
  expect(creates[0]?.query).toMatch(/IF NOT EXISTS/i);
  expect(creates[0]?.query).toMatch(/\bWAIT\b/i);
  expect(calls.some((c) => /\bDROP\b/i.test(c.query))).toBe(false);
}

beforeEach(() => {
  script = { create: { rows: [] }, show: [], calls: [] };
  calls = script.calls;
});

describe('GraphService.createOrgDatabase fails at once when the new database is not online (D217)', () => {
  it(
    '(a) rejects with OrgDatabaseNotOnline when the WAIT result reports a failure',
    async () => {
      script.create = { rows: [waitFailed] };
      // Even if the status read afterwards says online, a failed WAIT is a failure (D217).
      script.show = [status('online'), status('online'), status('online')];
      const graph = service();
      try {
        const err = await rejection(graph.createOrgDatabase(ORG_ID));
        expectNotOnline(err, /fail/i);
        expectOneCreateInSystemAsAdmin();
        expect(showCalls().length).toBeLessThanOrEqual(1);
      } finally {
        await graph.close();
      }
    },
    SETTLE_MS,
  );

  it(
    '(b) rejects at once when WAIT succeeds but currentStatus is offline, reading the status at most once',
    async () => {
      script.create = { rows: [waitOk] };
      script.show = Array.from({ length: 1000 }, () => status('offline'));
      const graph = service();
      try {
        const err = await rejection(graph.createOrgDatabase(ORG_ID));
        expectNotOnline(err, /^offline$/);
        expectOneCreateInSystemAsAdmin();
        expect(showCalls().length).toBeLessThanOrEqual(1);
      } finally {
        await graph.close();
      }
    },
    SETTLE_MS,
  );

  it(
    '(c) rejects at once when currentStatus is quarantined',
    async () => {
      script.create = { rows: [waitOk] };
      script.show = Array.from({ length: 1000 }, () => status('quarantined'));
      const graph = service();
      try {
        const err = await rejection(graph.createOrgDatabase(ORG_ID));
        expectNotOnline(err, /^quarantined$/);
        expectOneCreateInSystemAsAdmin();
        expect(showCalls().length).toBeLessThanOrEqual(1);
      } finally {
        await graph.close();
      }
    },
    SETTLE_MS,
  );

  it(
    '(d) keeps checking while starting, then rejects on the read that sees offline',
    async () => {
      script.create = { rows: [waitOk] };
      script.show = [status('starting'), status('offline'), ...Array.from({ length: 1000 }, () => status('offline'))];
      const graph = service();
      try {
        const err = await rejection(graph.createOrgDatabase(ORG_ID));
        expectNotOnline(err, /^offline$/);
        expectOneCreateInSystemAsAdmin();
        expect(showCalls()).toHaveLength(2);
      } finally {
        await graph.close();
      }
    },
    SETTLE_MS,
  );

  it(
    '(e) resolves when the new database is online',
    async () => {
      script.create = { rows: [waitOk] };
      script.show = [status('online')];
      const graph = service();
      try {
        await expect(graph.createOrgDatabase(ORG_ID)).resolves.toBeUndefined();
        expectOneCreateInSystemAsAdmin();
        expect(showCalls()).toHaveLength(1);
        expect(showCalls()[0]?.database).toBe('system');
      } finally {
        await graph.close();
      }
    },
    SETTLE_MS,
  );

  it(
    '(f) resolves when the create finds an existing database that is online (safe to re-run, M0-004)',
    async () => {
      const exists = Object.assign(new Error('Existing database found'), {
        code: 'Neo.ClientError.Database.ExistingDatabaseFound',
      });
      script.create = { error: exists };
      script.show = [status('online')];
      const graph = service();
      try {
        await expect(graph.createOrgDatabase(ORG_ID)).resolves.toBeUndefined();
        expectOneCreateInSystemAsAdmin();
        expect(showCalls()).toHaveLength(1);
      } finally {
        await graph.close();
      }
    },
    SETTLE_MS,
  );
});
