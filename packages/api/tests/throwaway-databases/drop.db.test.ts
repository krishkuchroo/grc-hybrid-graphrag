// S1-014 criterion 5 (D82, D176, D214 (8)): against the real Neo4j Desktop DBMS, the tracker drops
// the throwaway databases it tracked. No timing is asserted.
//
// As the Desktop `neo4j` account through `superDriver()` (the password comes from the existing
// `graphTestEnv()`, as in M0-004's tests/graph/org-database.db.test.ts). Only the two
// `org-<random uuid>` databases made here are ever created or dropped; nothing shared changes.
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseExists, newOrgId, runOn, superDriver } from '../graph/helpers.js';
import { ThrowawayDatabases } from '../graph/throwaway-databases.js';

const LONG = 180_000;

let sup: Driver;
let tracker: ThrowawayDatabases;
/** A second tracker for the tear-down, so a failed test can't leave the two databases behind. */
let cleanup: ThrowawayDatabases;
const made = [`org-${newOrgId()}`, `org-${newOrgId()}`];

beforeAll(async () => {
  sup = superDriver();
  tracker = new ThrowawayDatabases(sup);
  cleanup = new ThrowawayDatabases(sup);
  for (const name of made) {
    cleanup.track(name);
    tracker.track(name);
    await runOn(sup, 'system', `CREATE DATABASE \`${name}\` IF NOT EXISTS WAIT`);
  }
}, LONG);

afterAll(async () => {
  try {
    if (cleanup) await cleanup.dropAll();
  } finally {
    await sup?.close();
  }
}, LONG);

describe('ThrowawayDatabases against Neo4j (criterion 5)', () => {
  it(
    'two tracked org-<uuid> databases exist, and after dropAll SHOW DATABASES lists neither',
    async () => {
      // Both exist first, so the check after dropAll is not empty by accident.
      for (const name of made) expect(await databaseExists(sup, name), name).toBe(true);
      await tracker.dropAll();
      const listed = (await runOn(sup, 'system', 'SHOW DATABASES YIELD name RETURN DISTINCT name')).map((r) =>
        String(r['name']),
      );
      expect(listed.filter((n) => made.includes(n))).toEqual([]);
      expect(tracker.names()).toEqual([]);
    },
    LONG,
  );
});
