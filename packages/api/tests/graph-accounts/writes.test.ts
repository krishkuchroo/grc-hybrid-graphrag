// M0-005 criterion 2: every write (CREATE, MERGE, SET, DELETE) fails for every one of the 28
// accounts, and leaves the graph as it was.
// Decisions: D52.2 (AI-written graph queries run read-only), D57, D73.
//
// Two ways in, for every account:
// - Straight to Neo4j as the account (impersonation, WRITE session): the database's own
//   privileges must refuse the write (a Neo4j client error, not a failed login).
// - Through `GraphService.readAs`: the write must fail there too.
// Each account first reads a node it may see, so a refusal can't come from a missing account.
//
// Needs the running Neo4j Desktop DBMS (bolt://127.0.0.1:7687).
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  LONG,
  createFixtureOrg,
  dropDatabases,
  fixtureNodeId,
  impersonatedRunner,
  newGraph,
  readAsRunner,
  refused,
  runOn,
  runSetupNeo4j,
  superDriver,
  type FixtureOrg,
  type QueryGraph,
} from './helpers.js';

let sup: Driver;
let graph: QueryGraph | undefined;
let org: FixtureOrg;
// A node every account may see: frameworks are viewable by every role (D50), and public by label.
let target: string;
let otherTarget: string;

interface GraphState {
  nodes: number;
  rels: number;
  targetName: unknown;
  probes: number;
}

async function state(): Promise<GraphState> {
  const [row] = await runOn(
    sup,
    org.database,
    `CALL () { MATCH (n) RETURN count(n) AS nodes }
     CALL () { MATCH ()-[r]->() RETURN count(r) AS rels }
     CALL () { MATCH (t {id: $target}) RETURN t.name AS targetName }
     CALL () { MATCH (p) WHERE p.probe = true RETURN count(p) AS probes }
     RETURN nodes, rels, targetName, probes`,
    { target },
  );
  return row as unknown as GraphState;
}

function writes(): Record<string, string> {
  return {
    CREATE: `CREATE (:Asset {id: 'write-probe', name: 'write-probe', sensitivity: 'public', probe: true})`,
    'CREATE link': `MATCH (a {id: '${target}'}), (b {id: '${otherTarget}'}) CREATE (a)-[:CONCERNS {probe: true}]->(b)`,
    MERGE: `MERGE (:Risk {id: 'merge-probe', name: 'merge-probe', sensitivity: 'public', probe: true})`,
    SET: `MATCH (n {id: '${target}'}) SET n.name = 'changed by a query account'`,
    DELETE: `MATCH (n {id: '${target}'}) DETACH DELETE n`,
  };
}

beforeAll(async () => {
  sup = superDriver();
  runSetupNeo4j();
  org = await createFixtureOrg(sup);
  target = fixtureNodeId(org.orgId, 'Framework', 'public');
  otherTarget = fixtureNodeId(org.orgId, 'Requirement', 'public');
  try {
    graph = newGraph();
  } catch {
    graph = undefined;
  }
}, LONG);

afterAll(async () => {
  await graph?.close();
  if (sup && org) await dropDatabases(sup, [org.database]).catch(() => undefined);
  await sup?.close();
}, LONG);

describe.each(ACCOUNTS)('$name cannot write (criterion 2)', (account) => {
  it('is refused by Neo4j itself for CREATE, MERGE, SET and DELETE', async () => {
    const before = await state();
    const read = impersonatedRunner(sup, account, 'READ');
    const rows = await read(org, `MATCH (n {id: '${target}'}) RETURN n.id AS id`);
    expect(
      rows.map((r) => r['id']),
      'the account must exist and see the target first',
    ).toEqual([target]);

    const run = impersonatedRunner(sup, account, 'WRITE');
    for (const [kind, cypher] of Object.entries(writes())) {
      try {
        await refused(run(org, cypher));
      } catch (err) {
        throw new Error(`${kind} as ${account.name}: ${(err as Error).message}`, { cause: err });
      }
    }
    expect(await state()).toEqual(before);
  });

  it('fails through GraphService.readAs for CREATE, MERGE, SET and DELETE', async () => {
    const before = await state();
    const run = readAsRunner(graph, account);
    const ok = await run(org, `MATCH (n {id: '${target}'}) RETURN n.id AS id`);
    expect(ok.map((r) => r['id'])).toEqual([target]);
    for (const [kind, cypher] of Object.entries(writes())) {
      await expect(run(org, cypher), `${kind} as ${account.name}`).rejects.toThrow();
    }
    expect(await state()).toEqual(before);
  });
});
