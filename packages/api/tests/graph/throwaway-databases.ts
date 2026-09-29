// The one shared tracker for throwaway Neo4j databases (S1-014, test writer's file, D89/D96).
//
// Decisions: D82 (throwaway databases per agent, dropped afterwards), D171 (no retries, no
// swallowed failures), D176 (only databases the test made itself are ever dropped), D214 (8) (the
// admin account has no DROP DATABASE; cleanup uses the Desktop `neo4j` account), D163 and D164
// (names only in messages, never a password or a driver error's text).
//
// How every test that makes a Neo4j database uses it:
// - `track(name)` BEFORE the database is created, so a create that half-fails is still cleaned up.
//   Only `org-<lowercase uuid>` names are accepted: the tracker can never drop `neo4j`, `system`,
//   `restore-test` or any other named database.
// - `await tracker.dropAll()` in the tear-down, with no `.catch`. Other tear-down steps sit in a
//   `finally`, so they still run, and the rejection fails `afterAll` naming the database.
// - `dropAll` drops each tracked name once, one at a time, with `DROP DATABASE … IF EXISTS WAIT`
//   in `system`, then checks with `SHOW DATABASES` that none is still listed. The ones that are
//   gone are forgotten; any that threw or are still listed make it reject with `LeftoverDatabases`.
import type { Driver } from 'neo4j-driver';

const ORG_DATABASE = /^org-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Throwaway databases a tear-down couldn't drop. The message holds their names and nothing else. */
export class LeftoverDatabases extends Error {
  readonly names: string[];

  constructor(names: string[]) {
    super(`Throwaway Neo4j databases left behind: ${names.join(', ')}`);
    this.name = 'LeftoverDatabases';
    this.names = [...names];
  }
}

export class ThrowawayDatabases {
  private readonly tracked = new Set<string>();

  constructor(private readonly driver: Driver) {}

  /** Registers `name` for `dropAll`. Call it before the database is created. */
  track(name: string): void {
    if (!ORG_DATABASE.test(name)) {
      throw new Error('ThrowawayDatabases.track accepts only org-<lowercase uuid> names');
    }
    this.tracked.add(name);
  }

  /** The names still tracked, in the order they were first tracked. */
  names(): string[] {
    return [...this.tracked];
  }

  /** Drops every tracked database, checks none is still listed, and forgets the ones that are gone. */
  async dropAll(): Promise<void> {
    const names = this.names();
    if (names.length === 0) return;
    const failed = new Set<string>();
    for (const name of names) {
      try {
        await this.run(`DROP DATABASE \`${name}\` IF EXISTS WAIT`);
      } catch {
        // The driver's error text is never passed on (D164): the name alone goes into LeftoverDatabases.
        failed.add(name);
      }
    }
    let listed: Set<string>;
    try {
      const rows = await this.run('SHOW DATABASES YIELD name RETURN DISTINCT name');
      listed = new Set(rows.map((name) => String(name)));
    } catch {
      // Couldn't check: nothing counts as gone.
      throw new LeftoverDatabases(names);
    }
    const left = names.filter((name) => failed.has(name) || listed.has(name));
    for (const name of names) if (!left.includes(name)) this.tracked.delete(name);
    if (left.length > 0) throw new LeftoverDatabases(left);
  }

  private async run(cypher: string): Promise<unknown[]> {
    const session = this.driver.session({ database: 'system' });
    try {
      const res = await session.run(cypher);
      return res.records.map((r) => r.get('name') as unknown);
    } finally {
      await session.close();
    }
  }
}
