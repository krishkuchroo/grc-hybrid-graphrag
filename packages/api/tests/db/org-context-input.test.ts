// M0-003 criterion 5: invalid input to `withOrgContext` throws before any SQL runs.
// Invalid means: an org ID that isn't a UUID, a role outside the seven role names, a
// clearance outside the four label names (names are exact, lowercase), or an empty user ID.
// The Db here points at a port nothing listens on: if withOrgContext touched the database,
// the error would be a connection error. The error must name the bad field, and fn must
// never be called. Either a synchronous throw or a rejected promise counts as "throws".
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { closeDb, load, type Loaded } from './helpers.js';

type Ctx = Parameters<Loaded['withOrgContext']>[1];

const UNREACHABLE = 'postgres://grc_app:unused@127.0.0.1:1/none';

function ctx(over: Partial<Record<keyof Ctx, string>> = {}): Ctx {
  return {
    orgId: randomUUID(),
    userId: randomUUID(),
    role: 'risk_manager',
    clearance: 'confidential',
    ...over,
  } as unknown as Ctx;
}

// Message, code and JSON of an error and its causes (driver errors are often wrapped).
function errText(err: unknown, depth = 0): string {
  if (err === null || err === undefined || depth > 4) return '';
  const e = err as { message?: unknown; code?: unknown; cause?: unknown; errors?: unknown[] };
  let json: string;
  try {
    json = JSON.stringify(err) ?? '';
  } catch {
    json = '';
  }
  const nested = [e.cause, ...(Array.isArray(e.errors) ? e.errors : [])].map((c) => errText(c, depth + 1));
  return [String(e.message ?? ''), String(e.code ?? ''), json, ...nested].join(' ');
}

let loaded: Loaded;

beforeAll(async () => {
  loaded = await load();
});

const cases: [string, Partial<Record<keyof Ctx, string>>, RegExp][] = [
  ['a non-UUID org ID', { orgId: 'not-a-uuid' }, /orgId/],
  ['an empty org ID', { orgId: '' }, /orgId/],
  ['an org ID carrying SQL', { orgId: "00000000-0000-0000-0000-000000000000'; DROP TABLE x; --" }, /orgId/],
  ['an unknown role', { role: 'superadmin' }, /role/],
  ['a role in the wrong case', { role: 'Admin' }, /role/],
  ['an unknown clearance', { clearance: 'secret' }, /clearance/],
  ['a clearance in the wrong case', { clearance: 'Internal' }, /clearance/],
  ['an empty user ID', { userId: '' }, /userId/],
];

describe('invalid input throws before any SQL runs (criterion 5)', () => {
  it.each(cases)('rejects %s without touching the database', async (_name, over, field) => {
    const db = loaded.createDb(UNREACHABLE, { max: 1 });
    let called = false;
    try {
      const err = await Promise.resolve()
        .then(() =>
          loaded.withOrgContext(db, ctx(over), async () => {
            called = true;
            return 1;
          }),
        )
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err, 'withOrgContext must throw').toBeInstanceOf(Error);
      const text = errText(err);
      expect(text).not.toMatch(/ECONNREFUSED|connect/i);
      expect(text).toMatch(field);
      expect(called).toBe(false);
    } finally {
      await closeDb(db);
    }
  });

  it('a valid context gets past validation (it then fails only on the unreachable database)', async () => {
    const db = loaded.createDb(UNREACHABLE, { max: 1 });
    try {
      const err = await Promise.resolve()
        .then(() => loaded.withOrgContext(db, ctx(), async () => 1))
        .then(
          () => undefined,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(Error);
      expect(errText(err)).toMatch(/ECONNREFUSED|connect/i);
    } finally {
      await closeDb(db);
    }
  });
});
