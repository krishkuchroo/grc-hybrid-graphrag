// M0-005 criterion 7, live (D131): a refused query never reaches Neo4j, so a query meant for
// org-A that names org-B gets nothing from org-B.
//
// Why (brief): the 28 accounts are shared by every org, so their database privileges alone
// don't stop a query that says `USE org-B`. Our code must refuse it first.
//
// Contract:
// - Path B (S6) runs every AI-written query through `assertNoDatabaseReference` before
//   `readAs`; a refused query never gets as far as opening a session.
// - `readAs` itself also refuses such a query inside its transaction, the same way M0-004's
//   `read` and `write` do (D144): `tx.run` throws GraphQueryRefused without sending it. The
//   proof it wasn't sent: a query that is also broken Cypher comes back as GraphQueryRefused,
//   not as a Neo4j syntax error (which only the server could raise).
//
// Needs the running Neo4j Desktop DBMS (bolt://127.0.0.1:7687).
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  LONG,
  createFixtureOrg,
  ThrowawayDatabases,
  loadAssertNoDatabaseReference,
  loadGraphQueryRefused,
  newGraph,
  requireReadAs,
  runSetupNeo4j,
  superDriver,
  type FixtureOrg,
  type QueryGraph,
} from './helpers.js';

let sup: Driver;
let databases: ThrowawayDatabases;
let graph: QueryGraph | undefined;
let orgA: FixtureOrg;
let orgB: FixtureOrg;

beforeAll(async () => {
  sup = superDriver();
  databases = new ThrowawayDatabases(sup);
  runSetupNeo4j();
  orgA = await createFixtureOrg(sup, databases);
  orgB = await createFixtureOrg(sup, databases);
  try {
    graph = newGraph();
  } catch {
    graph = undefined;
  }
}, LONG);

afterAll(async () => {
  try {
    await graph?.close();
    if (databases) await databases.dropAll();
  } finally {
    await sup?.close();
  }
}, LONG);

const crossOrg = (): string[] => [
  `USE \`${orgB.database}\` MATCH (n) RETURN n.id AS id`,
  `use \`${orgB.database}\` match (n) return n.id as id`,
  `MATCH (a:Asset) CALL { USE \`${orgB.database}\` MATCH (n) RETURN n.id AS id } RETURN id`,
  `USE graph.byName('${orgB.database}') MATCH (n) RETURN n.id AS id`,
];

/** What S6's Path B does: check the text, then run it with readAs. */
async function pathB(
  cypher: string,
  account: (typeof ACCOUNTS)[number],
): Promise<{ rows: unknown[]; fnCalled: boolean }> {
  const assertNoDatabaseReference = await loadAssertNoDatabaseReference();
  let fnCalled = false;
  assertNoDatabaseReference(cypher);
  const rows = await requireReadAs(graph).readAs(
    orgA.orgId,
    account.role,
    account.clearance,
    async (tx) => {
      fnCalled = true;
      return (await tx.run(cypher)).records.map((r) => r.get('id') as unknown);
    },
    { timeoutMs: 30_000 },
  );
  return { rows, fnCalled };
}

const TOP = ACCOUNTS.filter((a) => a.clearance === 'restricted');

describe.each(TOP)('$name, asked about org-A (criterion 7, D131)', (account) => {
  it('Path B refuses every query that names org-B before readAs runs', async () => {
    const GraphQueryRefused = await loadGraphQueryRefused();
    for (const cypher of crossOrg()) {
      let thrown: unknown;
      let result: { rows: unknown[]; fnCalled: boolean } | undefined;
      try {
        result = await pathB(cypher, account);
      } catch (err) {
        thrown = err;
      }
      expect(result, `${cypher} must not return rows`).toBeUndefined();
      expect(thrown, cypher).toBeInstanceOf(GraphQueryRefused);
    }
  });

  it('readAs refuses a query naming org-B inside its transaction, and returns nothing from org-B', async () => {
    const GraphQueryRefused = await loadGraphQueryRefused();
    for (const cypher of crossOrg()) {
      let thrown: (Error & { code?: string }) | undefined;
      let rows: unknown[] | undefined;
      try {
        rows = await requireReadAs(graph).readAs(
          orgA.orgId,
          account.role,
          account.clearance,
          async (tx) => (await tx.run(cypher)).records.map((r) => r.get('id') as unknown),
          { timeoutMs: 30_000 },
        );
      } catch (err) {
        thrown = err as Error & { code?: string };
      }
      expect(rows, `${cypher} returned rows`).toBeUndefined();
      expect(thrown, cypher).toBeInstanceOf(GraphQueryRefused);
      expect(thrown?.code, 'the refusal must come from our code, not Neo4j').toBeUndefined();
    }
  });

  it('readAs refuses before sending: broken Cypher that names org-B is refused, not a Neo4j syntax error', async () => {
    const GraphQueryRefused = await loadGraphQueryRefused();
    let thrown: (Error & { code?: string }) | undefined;
    try {
      await requireReadAs(graph).readAs(
        orgA.orgId,
        account.role,
        account.clearance,
        async (tx) => (await tx.run(`USE \`${orgB.database}\` MATCH (n RETURN n`)).records.length,
        { timeoutMs: 30_000 },
      );
    } catch (err) {
      thrown = err as Error & { code?: string };
    }
    expect(thrown).toBeInstanceOf(GraphQueryRefused);
    expect(String(thrown?.code ?? '')).not.toMatch(/^Neo\./);
  });

  it('still answers an ordinary org-A query with org-A data only', async () => {
    const { rows, fnCalled } = await pathB('MATCH (a:Asset) RETURN a.id AS id', account);
    expect(fnCalled).toBe(true);
    expect(rows.length).toBeGreaterThan(0);
    for (const id of rows) expect(String(id).startsWith(`${orgA.orgId}:`)).toBe(true);
  });
});
