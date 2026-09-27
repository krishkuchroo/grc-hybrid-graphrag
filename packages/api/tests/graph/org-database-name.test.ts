// M0-004 criterion 5: a bad org ID throws before any query runs.
// Decisions: D22 (the org ID picks the database), D45.2 (graph access behind a small interface).
//
// Contract:
// - `orgDatabaseName(orgId)` in packages/api/src/graph/org-database.ts returns `org-<orgId>`
//   and throws for anything that isn't a lowercase UUID (8-4-4-4-12 hex, lowercase only).
// - `new GraphService({ uri, adminPassword, writerPassword })` in
//   packages/api/src/graph/graph.service.ts, with `close(): Promise<void>`.
//   `createOrgDatabase`, `write` and `read` reject for a bad org ID without calling the
//   caller's function and without talking to Neo4j. These tests point the service at a
//   port where nothing listens, so the only way to get the right error is to check the ID
//   first. No Neo4j is needed for this file.
import { describe, expect, it, vi } from 'vitest';

const GOOD = '3f2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b';

const BAD_IDS: [string, unknown][] = [
  ['empty string', ''],
  ['upper-case UUID', GOOD.toUpperCase()],
  ['mixed-case UUID', '3F2b8c1e-9a4d-4e6f-8b7a-0c1d2e3f4a5b'],
  ['not a UUID', 'not-a-uuid'],
  ['UUID without hyphens', GOOD.replaceAll('-', '')],
  ['UUID with a trailing space', `${GOOD} `],
  ['UUID with a leading space', ` ${GOOD}`],
  ['UUID with a trailing newline', `${GOOD}\n`],
  ['already prefixed', `org-${GOOD}`],
  ['UUID in braces', `{${GOOD}}`],
  ['too short', GOOD.slice(0, -1)],
  ['too long', `${GOOD}0`],
  ['non-hex letter', GOOD.replace('f', 'g')],
  ['backtick injection', `${GOOD}\`; DROP DATABASE neo4j; //`],
  ['wildcard', '*'],
  ['path traversal', '../system'],
  ['system database', 'system'],
  ['default database', 'neo4j'],
  ['number', 42],
  ['null', null],
  ['undefined', undefined],
];

async function orgDatabaseModule() {
  return import('../../src/graph/org-database.js');
}

async function graphServiceModule() {
  return import('../../src/graph/graph.service.js');
}

describe('orgDatabaseName', () => {
  it('returns org-<orgId> for a lowercase UUID', async () => {
    const { orgDatabaseName } = await orgDatabaseModule();
    expect(orgDatabaseName(GOOD)).toBe(`org-${GOOD}`);
  });

  it('accepts any lowercase UUID, not just one fixed value', async () => {
    const { orgDatabaseName } = await orgDatabaseModule();
    const other = '00000000-0000-4000-8000-000000000000';
    expect(orgDatabaseName(other)).toBe(`org-${other}`);
  });

  it.each(BAD_IDS)('throws for %s', async (_label, bad) => {
    const { orgDatabaseName } = await orgDatabaseModule();
    expect(() => orgDatabaseName(bad as string)).toThrow();
  });
});

describe('GraphService refuses a bad org ID before any query', () => {
  // Nothing listens on port 1, so a service that tried to reach Neo4j first would fail
  // with a connection error instead of the org-ID error.
  const unreachable = { uri: 'bolt://127.0.0.1:1', adminPassword: 'unused-admin', writerPassword: 'unused-writer' };

  function isConnectionError(err: unknown): boolean {
    const e = err as { code?: string; message?: string };
    return (
      e?.code === 'ServiceUnavailable' ||
      e?.code === 'SessionExpired' ||
      /ECONNREFUSED|ServiceUnavailable|Could not perform discovery|connect/i.test(e?.message ?? '')
    );
  }

  async function expectRejectsBeforeQuery(call: () => Promise<unknown>): Promise<void> {
    let error: unknown;
    try {
      await call();
    } catch (err) {
      error = err;
    }
    expect(error, 'expected a rejection for the bad org ID').toBeInstanceOf(Error);
    expect(isConnectionError(error), `got a connection error instead: ${String(error)}`).toBe(false);
  }

  it.each(BAD_IDS)('createOrgDatabase rejects %s', async (_label, bad) => {
    const { GraphService } = await graphServiceModule();
    const svc = new GraphService(unreachable);
    try {
      await expectRejectsBeforeQuery(() => svc.createOrgDatabase(bad as string));
    } finally {
      await svc.close();
    }
  });

  it.each(BAD_IDS)('write rejects %s without calling the function', async (_label, bad) => {
    const { GraphService } = await graphServiceModule();
    const svc = new GraphService(unreachable);
    const fn = vi.fn(async () => 'ran');
    try {
      await expectRejectsBeforeQuery(() => svc.write(bad as string, fn));
      expect(fn).not.toHaveBeenCalled();
    } finally {
      await svc.close();
    }
  });

  it.each(BAD_IDS)('read rejects %s without calling the function', async (_label, bad) => {
    const { GraphService } = await graphServiceModule();
    const svc = new GraphService(unreachable);
    const fn = vi.fn(async () => 'ran');
    try {
      await expectRejectsBeforeQuery(() => svc.read(bad as string, fn));
      expect(fn).not.toHaveBeenCalled();
    } finally {
      await svc.close();
    }
  });
});
