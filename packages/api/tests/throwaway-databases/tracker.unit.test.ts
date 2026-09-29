// S1-014 criterion 4 (D82, D171, D163, D164, D214 (8)): the ThrowawayDatabases tracker, against a
// stub driver (no Neo4j).
//
// The stub stands in for the Desktop `neo4j` account's driver: it keeps a set of databases that
// "exist", answers `SHOW DATABASES` with all of them plus `neo4j` and `system`, and answers
// `DROP DATABASE \`<name>\` …` by removing the name. It can be told to make a drop throw (with an
// error text that holds a fake password), or to "keep" a database (the drop returns but the name
// is still listed). It records every query with the database it ran in.
import { randomUUID } from 'node:crypto';
import type { Driver } from 'neo4j-driver';
import { describe, expect, it } from 'vitest';
import { LeftoverDatabases, ThrowawayDatabases } from '../graph/throwaway-databases.js';

const PASSWORD = 'stub-password-Zq8x1T4v';
const ERROR_TEXT = `connection refused for neo4j with password ${PASSWORD}`;

interface Ran {
  database: string | undefined;
  cypher: string;
}

class StubDriver {
  readonly ran: Ran[] = [];
  readonly existing = new Set<string>();
  readonly throwOn = new Set<string>();
  readonly keep = new Set<string>();

  session(opts: { database?: string } = {}) {
    return {
      run: async (cypher: string) => {
        this.ran.push({ database: opts.database, cypher });
        const drop = /^DROP DATABASE `([^`]+)`/.exec(cypher);
        if (drop) {
          const name = drop[1]!;
          if (this.throwOn.has(name)) {
            const err = new Error(ERROR_TEXT) as Error & { code?: string };
            err.code = 'Neo.ClientError.Security.Unauthorized';
            throw err;
          }
          if (!this.keep.has(name)) this.existing.delete(name);
          return { records: [] };
        }
        if (/^SHOW DATABASES/.test(cypher)) {
          const names = ['neo4j', 'system', ...this.existing];
          return {
            records: names.map((name) => ({
              get: (key: string) => (key === 'name' ? name : undefined),
              toObject: () => ({ name }),
            })),
          };
        }
        throw new Error(`stub driver: unexpected query ${cypher}`);
      },
      close: async () => undefined,
    };
  }

  drops(): Ran[] {
    return this.ran.filter((r) => /^DROP DATABASE/.test(r.cypher));
  }
}

function orgDb(): string {
  return `org-${randomUUID()}`;
}

function setUp(...names: string[]): { stub: StubDriver; tracker: ThrowawayDatabases } {
  const stub = new StubDriver();
  const tracker = new ThrowawayDatabases(stub as unknown as Driver);
  for (const n of names) {
    stub.existing.add(n);
    tracker.track(n);
  }
  return { stub, tracker };
}

async function rejection(p: Promise<unknown>): Promise<LeftoverDatabases> {
  let caught: unknown;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  expect(caught, 'dropAll should have rejected').toBeInstanceOf(LeftoverDatabases);
  return caught as LeftoverDatabases;
}

describe('ThrowawayDatabases.track (criterion 4)', () => {
  it.each([
    ['neo4j', 'neo4j'],
    ['system', 'system'],
    ['restore-test (D214 (8))', 'restore-test'],
    ['org- plus something that is not a UUID', 'org-NOT-A-UUID'],
    ['org- plus an upper-case UUID', `org-${randomUUID().toUpperCase()}`],
    ['a bare UUID', randomUUID()],
    ['org- plus a UUID with something after it', `org-${randomUUID()}-x`],
    ['org- plus a UUID with a backtick after it', `org-${randomUUID()}\``],
  ])('throws for %s', (_what, name) => {
    const { tracker } = setUp();
    expect(() => tracker.track(name)).toThrow();
    expect(tracker.names()).toEqual([]);
  });

  it('accepts org-<lowercase uuid> and lists it in names()', () => {
    const a = orgDb();
    const b = orgDb();
    const { tracker } = setUp();
    tracker.track(a);
    tracker.track(b);
    expect(tracker.names()).toEqual([a, b]);
  });

  it('lists a name tracked twice once', () => {
    const a = orgDb();
    const { tracker } = setUp();
    tracker.track(a);
    tracker.track(a);
    expect(tracker.names()).toEqual([a]);
  });
});

describe('ThrowawayDatabases.dropAll (criterion 4)', () => {
  it('drops each tracked name once, in system, with DROP DATABASE `<name>` IF EXISTS WAIT', async () => {
    const a = orgDb();
    const b = orgDb();
    const { stub, tracker } = setUp(a, b);
    await tracker.dropAll();
    const drops = stub.drops();
    expect(drops.map((d) => d.cypher)).toEqual([
      `DROP DATABASE \`${a}\` IF EXISTS WAIT`,
      `DROP DATABASE \`${b}\` IF EXISTS WAIT`,
    ]);
    expect(drops.every((d) => d.database === 'system')).toBe(true);
    expect(stub.existing.size).toBe(0);
  });

  it('checks with SHOW DATABASES in system after dropping', async () => {
    const a = orgDb();
    const { stub, tracker } = setUp(a);
    await tracker.dropAll();
    const lastDrop = stub.ran.findIndex((r) => /^DROP DATABASE/.test(r.cypher));
    const show = stub.ran.findIndex((r, i) => i > lastDrop && /^SHOW DATABASES/.test(r.cypher));
    expect(show).toBeGreaterThan(lastDrop);
    expect(stub.ran[show]!.database).toBe('system');
  });

  it('never drops neo4j, system or any name it was not given', async () => {
    const a = orgDb();
    const { stub, tracker } = setUp(a);
    stub.existing.add(orgDb());
    await tracker.dropAll();
    expect(stub.drops().map((d) => d.cypher)).toEqual([`DROP DATABASE \`${a}\` IF EXISTS WAIT`]);
  });

  it('forgets the dropped names: a second dropAll does nothing', async () => {
    const a = orgDb();
    const b = orgDb();
    const { stub, tracker } = setUp(a, b);
    await tracker.dropAll();
    expect(tracker.names()).toEqual([]);
    const before = stub.ran.length;
    await tracker.dropAll();
    expect(stub.drops()).toHaveLength(2);
    expect(stub.ran.slice(before).filter((r) => /^DROP DATABASE/.test(r.cypher))).toEqual([]);
  });

  it('resolves when a tracked database was never made (a refused create): IF EXISTS drops nothing', async () => {
    const a = orgDb();
    const { stub, tracker } = setUp();
    tracker.track(a);
    await expect(tracker.dropAll()).resolves.toBeUndefined();
    expect(stub.drops()).toHaveLength(1);
    expect(tracker.names()).toEqual([]);
  });

  it('rejects with LeftoverDatabases naming exactly the names whose drop threw, and still drops the rest', async () => {
    const a = orgDb();
    const b = orgDb();
    const c = orgDb();
    const { stub, tracker } = setUp(a, b, c);
    stub.throwOn.add(b);
    const err = await rejection(tracker.dropAll());
    expect(err.names).toEqual([b]);
    expect(err.message).toBe(`Throwaway Neo4j databases left behind: ${b}`);
    expect(stub.drops()).toHaveLength(3);
    expect([...stub.existing]).toEqual([b]);
  });

  it('rejects naming exactly the names SHOW DATABASES still lists after their drop', async () => {
    const a = orgDb();
    const b = orgDb();
    const c = orgDb();
    const { stub, tracker } = setUp(a, b, c);
    stub.keep.add(a);
    stub.keep.add(c);
    const err = await rejection(tracker.dropAll());
    expect(err.names).toEqual([a, c]);
    expect(err.message).toBe(`Throwaway Neo4j databases left behind: ${a}, ${c}`);
  });

  it('keeps tracking the leftovers and forgets the rest', async () => {
    const a = orgDb();
    const b = orgDb();
    const { stub, tracker } = setUp(a, b);
    stub.throwOn.add(a);
    await rejection(tracker.dropAll());
    expect(tracker.names()).toEqual([a]);
  });

  it('LeftoverDatabases is an Error with names', async () => {
    const a = orgDb();
    const { stub, tracker } = setUp(a);
    stub.keep.add(a);
    const err = await rejection(tracker.dropAll());
    expect(err).toBeInstanceOf(Error);
    expect(Array.isArray(err.names)).toBe(true);
  });

  it("neither the message nor names holds the driver's password or error text (D164)", async () => {
    const a = orgDb();
    const b = orgDb();
    const { stub, tracker } = setUp(a, b);
    stub.throwOn.add(a);
    stub.keep.add(b);
    const err = await rejection(tracker.dropAll());
    const shown = [err.message, ...err.names, String(err.stack ?? '')].join('\n');
    expect(shown).not.toContain(PASSWORD);
    expect(shown).not.toContain(ERROR_TEXT);
    expect(shown).not.toContain('Unauthorized');
    expect(err.names).toEqual([a, b]);
  });
});
