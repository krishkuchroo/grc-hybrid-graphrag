// S1-004 criterion 8 (SF-006; D163, D164): an unexpected error on a record route logs only the
// error type or code, the reference ID, the method and the URL. Each test forces a failure whose
// error quotes a sentinel record name (the way a Neo4j or Postgres error quotes values), and checks
// that the sentinel is nowhere in the log or the answer, while the log line still carries the
// answer's reference ID, the method and the URL.
// The failures are forced by wrapping, for one request, the app's own objects the record routes
// use: the AuditOutbox (a write that fails after the service's work ran), the RecordsService (an
// error thrown past the service) and the GraphService (a read that fails). Each is put back after.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  LONG,
  T,
  base,
  createR,
  expectRefused,
  getR,
  newApiOrg,
  patchR,
  person,
  seed,
  setUpRecordsApi,
  tearDownRecordsApi,
  validInput,
  type ApiEnv,
  type InjectResponse,
  type Org,
  type SignedIn,
} from './helpers.js';

let env: ApiEnv | undefined;
let org: Org;
let admin: SignedIn;

beforeAll(async () => {
  env = await setUpRecordsApi();
  org = await newApiOrg(env, 'Records Api Error Log');
  admin = await person(env, org, 'admin', 'restricted');
}, LONG);

afterAll(async () => {
  await tearDownRecordsApi(env);
}, LONG);

function e(): ApiEnv {
  if (!env) throw new Error('set-up did not finish (see beforeAll)');
  return env;
}

class SentinelFailure extends Error {
  constructor(sentinel: string) {
    super(`Node(42) already exists with label \`Risk\` and property \`name\` = '${sentinel}'`);
    this.name = 'SentinelFailure';
  }
}

function sentinel(): string {
  return `SENTINEL-${randomUUID()}`;
}

/** Replaces `obj[name]` for the length of `fn`, then puts it back. */
async function patched<T>(obj: object, name: string, replacement: unknown, fn: () => Promise<T>): Promise<T> {
  const target = obj as Record<string, unknown>;
  const own = Object.hasOwn(target, name);
  const original = target[name];
  target[name] = replacement;
  try {
    return await fn();
  } finally {
    if (own) target[name] = original;
    else delete target[name];
  }
}

/** The 500 answer holds no sentinel; no log line does; the line with the reference ID has the rest. */
function expectCleanLog(res: InjectResponse, secret: string, method: string, url: string, errorType?: string): void {
  const body = expectRefused(res, 500);
  expect(res.body).not.toContain(secret);
  const leaking = e().logs.lines.filter((line) => line.includes(secret));
  expect(leaking, 'log lines holding the sentinel record name').toEqual([]);
  const lines = e().logs.lines.filter((line) => line.includes(body.error.referenceId));
  expect(lines.length, 'a log line carries the reference ID').toBeGreaterThan(0);
  const line = JSON.parse(lines[lines.length - 1]!) as Record<string, unknown>;
  expect(line['method']).toBe(method);
  expect(line['url']).toBe(url);
  expect(lines.join('\n'), 'no stack trace in the log line').not.toContain('"stack"');
  if (errorType) expect(lines.join('\n'), 'the error type is logged').toContain(errorType);
}

async function outboxToken(): Promise<unknown> {
  return (await import('../../src/audit/outbox.js')).AuditOutbox;
}

describe(
  'criterion 8: unexpected errors on record routes log no record values (SF-006, D163, D164)',
  { timeout: T },
  () => {
    it('POST: a failed audited write quoting the sentinel name', async () => {
      const secret = sentinel();
      const outbox = e().app.get<{ withAuditedWrite: (...a: unknown[]) => Promise<unknown> }>(await outboxToken());
      const real = outbox.withAuditedWrite.bind(outbox);
      const failing = (orgId: unknown, actor: unknown, fn: (tx: unknown) => Promise<unknown>) =>
        real(orgId, actor, async (tx: unknown) => {
          await fn(tx);
          throw new SentinelFailure(secret);
        });
      const res = await patched(outbox, 'withAuditedWrite', failing, () =>
        createR(e(), admin, 'risk', validInput('risk', { name: secret })),
      );
      expectCleanLog(res, secret, 'POST', base('risk'));
    });

    it('PATCH: an error thrown past the records service quoting the sentinel name', async () => {
      const secret = sentinel();
      const rec = await seed(e(), admin, 'risk');
      const res = await patched(
        e().records,
        'update',
        async () => {
          throw new SentinelFailure(secret);
        },
        () => patchR(e(), admin, 'risk', rec.id, { name: secret, version: rec.version }),
      );
      expectCleanLog(res, secret, 'PATCH', `${base('risk')}/${rec.id}`, 'SentinelFailure');
    });

    it('GET :id: a failed graph read quoting the sentinel name', async () => {
      const secret = sentinel();
      const rec = await seed(e(), admin, 'risk', { name: secret });
      const res = await patched(
        e().graph,
        'readAs',
        async () => {
          throw new SentinelFailure(secret);
        },
        () => getR(e(), admin, 'risk', rec.id),
      );
      expectCleanLog(res, secret, 'GET', `${base('risk')}/${rec.id}`, 'SentinelFailure');
    });
  },
);
