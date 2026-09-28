// M0-013 follow-up, D163 (Q42): when the audit outbox relay fails, its log line holds only the
// error's type and code, the org ID and the outbox entry's ID, never the entry's contents.
//
// Contract these tests hold `src/audit/outbox-relay.job.ts` to, for every log line it writes
// about a failure:
// - it is logged at error level (pino level 50) on the relay's `log`;
// - `orgId`  is the org whose outbox was being relayed;
// - `entryId` is the outbox node's id, when the failure was about one entry (append, parse or
//   delete). A failure reading the org's outbox is about no single entry, so it has no `entryId`;
// - `errorType` is the error's class name (`err.name`, e.g. 'DrizzleQueryError', 'SyntaxError');
// - `errorCode` is the error's `code` or, failing that, its `cause`'s `code`, when one is a string;
// - no value from the entry's payload (actor, action, target, before, after, meta) appears
//   anywhere in the line: not in `msg`, not in a serialised `err` (message, stack, own
//   properties, `cause`), not in any other field.
//
// The failures are the shapes real errors take: drizzle's DrizzleQueryError puts the query's
// params (the entry) in its message; a pg error carries the row in `detail`; JSON.parse quotes
// the text it could not parse; an error may carry the entry as a property or in its `cause`.
// The graph and audit services are fakes (no databases), so nothing here needs Neo4j or Postgres.
import { randomUUID } from 'node:crypto';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import type { ManagedTransaction } from 'neo4j-driver';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { AuditEventInput } from '../../src/audit/audit.service.js';
import { OutboxRelay, type OutboxRelayDeps } from '../../src/audit/outbox-relay.job.js';

// ---------- an entry whose every payload value is a marker we can look for ----------

// actorType is left out: it is one of 'user' | 'api_key' | 'system', words that appear in any log.
const MARKERS = [
  'LEAKactor7f3a',
  'LEAKaction1b2c.updated',
  'LEAKtargetType9d8e',
  'LEAKtargetId4455',
  'LEAKbeforeKey',
  'LEAKbeforeValue6612',
  'LEAKafterKey',
  'LEAKafterValue7723',
  'LEAKsummary: owner changed from Alice Example to Bob Example',
  'LEAKmetaValue8834',
] as const;

type Payload = Omit<AuditEventInput, 'orgId' | 'sourceId'>;

const PAYLOAD: Payload = {
  actorType: 'user',
  actorId: MARKERS[0],
  action: MARKERS[1],
  targetType: MARKERS[2],
  targetId: MARKERS[3],
  before: { [MARKERS[4]]: MARKERS[5], score: 3 },
  after: { [MARKERS[6]]: MARKERS[7], score: 4 },
  meta: { summary: MARKERS[8], note: MARKERS[9] },
};

/** Every marker, and also the fragments a shortened message could keep. */
function leaks(output: string): string[] {
  const found: string[] = MARKERS.filter((m) => output.includes(m));
  if (output.includes('LEAK')) found.push('LEAK (a fragment of an entry value)');
  if (output.includes('Alice Example') || output.includes('Bob Example')) found.push('summary text');
  return found;
}

// ---------- log capture ----------

interface Captured {
  lines: string[];
  records: Record<string, unknown>[];
}

function capture(): { log: OutboxRelayDeps['log'] & object; out: Captured } {
  const out: Captured = { lines: [], records: [] };
  const log = pino(
    { level: 'trace' },
    {
      write(line: string) {
        out.lines.push(line);
        out.records.push(JSON.parse(line) as Record<string, unknown>);
      },
    },
  );
  return { log, out };
}

function errorLines(out: Captured): Record<string, unknown>[] {
  return out.records.filter((r) => typeof r.level === 'number' && r.level >= 50);
}

// ---------- fakes ----------

interface FakeEntry {
  id: string;
  payload: string;
}

function fakeTx(entries: FakeEntry[], onRun?: (query: string, params: unknown) => void): ManagedTransaction {
  const tx = {
    run: async (query: string, params?: unknown) => {
      onRun?.(query, params);
      if (/RETURN/i.test(query)) {
        return {
          records: entries.map((e) => ({
            get: (k: string) => (k === 'id' ? e.id : k === 'payload' ? e.payload : undefined),
          })),
        };
      }
      return { records: [] };
    },
  };
  return tx as unknown as ManagedTransaction;
}

interface FakeGraphOptions {
  readError?: Error;
  writeError?: Error;
}

function fakeGraph(byOrg: Map<string, FakeEntry[]>, opts: FakeGraphOptions = {}): OutboxRelayDeps['graph'] {
  const graph = {
    async read<T>(orgId: string, fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
      if (opts.readError) throw opts.readError;
      return fn(fakeTx(byOrg.get(orgId) ?? []));
    },
    async write<T>(orgId: string, fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
      if (opts.writeError) throw opts.writeError;
      return fn(
        fakeTx([], (_q, params) => {
          const id = (params as { id?: string } | undefined)?.id;
          const list = byOrg.get(orgId) ?? [];
          byOrg.set(
            orgId,
            list.filter((e) => e.id !== id),
          );
        }),
      );
    },
  };
  return graph as unknown as OutboxRelayDeps['graph'];
}

function failingAudit(makeError: (input: AuditEventInput) => Error): OutboxRelayDeps['audit'] {
  return {
    async append(input: AuditEventInput) {
      throw makeError(input);
    },
  } as unknown as OutboxRelayDeps['audit'];
}

const okAudit = {
  async append() {
    return { seq: 1, hash: 'h' };
  },
} as unknown as OutboxRelayDeps['audit'];

// ---------- the errors ----------

/** What drizzle throws when Postgres rejects the insert: the params (the entry) are in the message. */
function drizzleError(input: AuditEventInput): Error {
  const pgError = Object.assign(new Error('unsupported Unicode escape sequence'), {
    name: 'error',
    code: '22P05',
    severity: 'ERROR',
    detail: `Failing row contains (${input.actorId}, ${input.action}, ${JSON.stringify(input.after)}).`,
    where: `JSON data, line 1: ${JSON.stringify(input.meta)}`,
  });
  return new DrizzleQueryError(
    'insert into "audit_events" ("org_id", "actor_id", "action", "target_type", "target_id", "before", "after", "meta") values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      input.orgId,
      input.actorId,
      input.action,
      input.targetType,
      input.targetId,
      JSON.stringify(input.before),
      JSON.stringify(input.after),
      JSON.stringify(input.meta),
    ],
    pgError,
  );
}

class AuditAppendError extends Error {
  constructor(
    message: string,
    readonly entry: AuditEventInput,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'AuditAppendError';
  }
}

/** An error with the entry attached as a property and its summary in the cause's message. */
function errorWithEntry(input: AuditEventInput): Error {
  const cause = new Error(`could not store ${input.targetId}: ${(input.meta as { summary: string }).summary}`);
  return new AuditAppendError(`append failed for ${input.actorId} ${input.action}`, input, { cause });
}

// ---------- helpers ----------

function setUp(): { orgId: string; entry: FakeEntry; byOrg: Map<string, FakeEntry[]> } {
  const orgId = randomUUID();
  const entry = { id: randomUUID(), payload: JSON.stringify(PAYLOAD) };
  return { orgId, entry, byOrg: new Map([[orgId, [entry]]]) };
}

async function settle(p: Promise<unknown>): Promise<void> {
  await p.catch(() => undefined);
}

function assertSafe(out: Captured): void {
  const errors = errorLines(out);
  // Something was logged about the failure (so "no leak" is not true only because nothing was logged).
  expect(errors.length, 'the relay logs the failure at error level').toBeGreaterThan(0);
  expect(leaks(out.lines.join('\n')), 'entry values found in the log output').toEqual([]);
}

function lineFor(out: Captured, entryId: string): Record<string, unknown> | undefined {
  return errorLines(out).find((r) => r.entryId === entryId);
}

// ---------- the tests ----------

describe('relay failure logs (D163): error type and code, org ID and entry ID only', () => {
  it('a Postgres append that fails with a DrizzleQueryError logs the type, code, org and entry ID', async () => {
    const { orgId, entry, byOrg } = setUp();
    const { log, out } = capture();
    const relay = new OutboxRelay({
      graph: fakeGraph(byOrg),
      audit: failingAudit(drizzleError),
      orgIds: async () => [orgId],
      log,
    });

    await settle(relay.runOnce());

    const line = lineFor(out, entry.id);
    expect(line, 'an error-level line with entryId = the outbox node id').toBeDefined();
    expect(line).toMatchObject({ orgId, entryId: entry.id, errorType: 'DrizzleQueryError', errorCode: '22P05' });
  });

  it('a Postgres append that fails with a DrizzleQueryError logs none of the entry (params, detail, where, stack)', async () => {
    const { orgId, byOrg } = setUp();
    const { log, out } = capture();
    const relay = new OutboxRelay({
      graph: fakeGraph(byOrg),
      audit: failingAudit(drizzleError),
      orgIds: async () => [orgId],
      log,
    });

    await settle(relay.runOnce());

    assertSafe(out);
  });

  it('an error carrying the entry as a property and in its cause logs its type, org and entry ID', async () => {
    const { orgId, entry, byOrg } = setUp();
    const { log, out } = capture();
    const relay = new OutboxRelay({
      graph: fakeGraph(byOrg),
      audit: failingAudit(errorWithEntry),
      orgIds: async () => [orgId],
      log,
    });

    await settle(relay.runOnce());

    expect(lineFor(out, entry.id)).toMatchObject({ orgId, entryId: entry.id, errorType: 'AuditAppendError' });
  });

  it('an error carrying the entry as a property and in its cause logs none of the entry', async () => {
    const { orgId, byOrg } = setUp();
    const { log, out } = capture();
    const relay = new OutboxRelay({
      graph: fakeGraph(byOrg),
      audit: failingAudit(errorWithEntry),
      orgIds: async () => [orgId],
      log,
    });

    await settle(relay.runOnce());

    assertSafe(out);
  });

  it('an outbox payload that is not valid JSON logs SyntaxError, org and entry ID, and none of the text', async () => {
    const { orgId, entry, byOrg } = setUp();
    // The actor's quotes lost: JSON.parse's message quotes the text around the bad token
    // (`Unexpected token 'L', ...""actorId":LEAKactor7"... is not valid JSON`).
    entry.payload = entry.payload.replace(`"${MARKERS[0]}"`, MARKERS[0]);
    expect(() => JSON.parse(entry.payload) as unknown).toThrow(/LEAK/);
    const { log, out } = capture();
    const relay = new OutboxRelay({ graph: fakeGraph(byOrg), audit: okAudit, orgIds: async () => [orgId], log });

    await settle(relay.runOnce());

    expect(lineFor(out, entry.id)).toMatchObject({ orgId, entryId: entry.id, errorType: 'SyntaxError' });
    assertSafe(out);
  });

  it('a failed delete after the append logs the Neo4j error type and code, org and entry ID, and none of the entry', async () => {
    const { orgId, entry, byOrg } = setUp();
    const neo4jError = Object.assign(new Error(`Could not delete outbox node holding ${entry.payload}`), {
      name: 'Neo4jError',
      code: 'Neo.TransientError.Transaction.Terminated',
    });
    const { log, out } = capture();
    const relay = new OutboxRelay({
      graph: fakeGraph(byOrg, { writeError: neo4jError }),
      audit: okAudit,
      orgIds: async () => [orgId],
      log,
    });

    await settle(relay.runOnce());

    expect(lineFor(out, entry.id)).toMatchObject({
      orgId,
      entryId: entry.id,
      errorType: 'Neo4jError',
      errorCode: 'Neo.TransientError.Transaction.Terminated',
    });
    assertSafe(out);
  });

  it('a failed read of the org outbox logs the error type and code and the org ID, and none of the error text', async () => {
    const { orgId, byOrg } = setUp();
    const readError = Object.assign(new Error(`read failed near ${JSON.stringify(PAYLOAD)}`), {
      name: 'Neo4jError',
      code: 'Neo.ClientError.Statement.ExecutionFailed',
    });
    const { log, out } = capture();
    const relay = new OutboxRelay({
      graph: fakeGraph(byOrg, { readError }),
      audit: okAudit,
      orgIds: async () => [orgId],
      log,
    });

    await settle(relay.runOnce());

    const line = errorLines(out).find((r) => r.orgId === orgId);
    expect(line).toMatchObject({
      orgId,
      errorType: 'Neo4jError',
      errorCode: 'Neo.ClientError.Statement.ExecutionFailed',
    });
    assertSafe(out);
  });

  it('while started, every failed pass logs the org and entry ID and none of the entry', async () => {
    const { orgId, entry, byOrg } = setUp();
    const { log, out } = capture();
    let calls = 0;
    const relay = new OutboxRelay({
      graph: fakeGraph(byOrg),
      audit: failingAudit((input) => {
        calls++;
        return drizzleError(input);
      }),
      orgIds: async () => [orgId],
      log,
      intervalMs: 20,
    });

    relay.start();
    const deadline = Date.now() + 5000;
    while (calls < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    await relay.stop();

    expect(calls, 'the relay kept retrying').toBeGreaterThanOrEqual(2);
    const lines = errorLines(out).filter((r) => r.entryId === entry.id);
    expect(lines.length, 'one error line per failed pass, each with the entry ID').toBeGreaterThanOrEqual(2);
    for (const l of lines) expect(l).toMatchObject({ orgId, errorType: 'DrizzleQueryError', errorCode: '22P05' });
    assertSafe(out);
  });

  it('a failure in one org names that org and its entry, and the other org is still relayed', async () => {
    const bad = setUp();
    const goodOrg = randomUUID();
    const goodEntry = { id: randomUUID(), payload: JSON.stringify({ ...PAYLOAD, actorId: 'fine' }) };
    const byOrg = new Map([
      [bad.orgId, [bad.entry]],
      [goodOrg, [goodEntry]],
    ]);
    const appended: string[] = [];
    const audit = {
      async append(input: AuditEventInput) {
        if (input.orgId === bad.orgId) throw errorWithEntry(input);
        appended.push(String(input.sourceId));
        return { seq: 1, hash: 'h' };
      },
    } as unknown as OutboxRelayDeps['audit'];
    const { log, out } = capture();
    const relay = new OutboxRelay({ graph: fakeGraph(byOrg), audit, orgIds: async () => [bad.orgId, goodOrg], log });

    await settle(relay.runOnce());

    expect(appended).toEqual([goodEntry.id]);
    expect(lineFor(out, bad.entry.id)).toMatchObject({ orgId: bad.orgId, entryId: bad.entry.id });
    expect(errorLines(out).some((r) => r.orgId === goodOrg)).toBe(false);
    assertSafe(out);
  });
});
