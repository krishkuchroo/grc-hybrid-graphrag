// M0-005 security review round 2 (commit 3d1c875): a graph query stays inside the org's database.
// Decisions: D52.2 (AI-written graph queries run read-only and can't reach outside Neo4j), D57, D73.
//
// The built-in PUBLIC role grants LOAD and EXECUTE on every procedure, so each of the 28 query
// accounts must be denied:
// - LOAD (LOAD CSV from an http:// or file:/// URL), and
// - the APOC procedures that read, write or send data outside Neo4j: apoc.load.*, apoc.import.*,
//   apoc.export.*, apoc.bolt.* and apoc.spatial.*.
//
// "Refused" here means Neo4j's own permission error (Neo.ClientError.Security.Forbidden with its
// "denied" / "not allowed" message). A connection error (nothing listens on 127.0.0.1:9), a missing
// file, "import from files not enabled" or a read-only access-mode error doesn't count: those mean
// the account was allowed to try. The import procedures run in a WRITE session so that only the
// DENY can explain the refusal. apoc.bolt.* isn't installed, so it is checked in the role's
// privileges instead.
//
// Needs the running Neo4j Desktop DBMS (bolt://127.0.0.1:7687). Throwaway data (D82): one empty
// org database `org-<random uuid>`, dropped in afterAll.
import { randomUUID } from 'node:crypto';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  LONG,
  dropDatabases,
  impersonatedRunner,
  newGraph,
  readAsRunner,
  runOn,
  runSetupNeo4j,
  superDriver,
  type Account,
  type FixtureOrg,
  type QueryGraph,
  type Runner,
} from './helpers.js';

const NOWHERE = 'http://127.0.0.1:9/x';
const LOCAL_FILE = 'file:///grc-outside-probe.csv';

const FORBIDDEN = 'Neo.ClientError.Security.Forbidden';
const LOAD_DENIED = /LOAD on URL .* is denied for user/;
const PROCEDURE_DENIED = /Executing procedure is not allowed for user/;
const TRIED_TO_REACH = /Connection refused|ConnectException|Couldn't load|Cannot load|not enabled|FileNotFound/i;

const LOADS: [string, string][] = [
  ['LOAD CSV from an http URL', `LOAD CSV FROM '${NOWHERE}' AS row RETURN row`],
  ['LOAD CSV WITH HEADERS from an http URL', `LOAD CSV WITH HEADERS FROM '${NOWHERE}' AS row RETURN row`],
  ['LOAD CSV from a file:/// URL', `LOAD CSV FROM '${LOCAL_FILE}' AS row RETURN row`],
];

/** Procedures that read or send data and need no write: run in a READ session, as the AI path does. */
const READ_PROCEDURES: [string, string][] = [
  ['apoc.load.json from an http URL', `CALL apoc.load.json('${NOWHERE}') YIELD value RETURN value`],
  ['apoc.load.json from a file:/// URL', `CALL apoc.load.json('file:///grc-outside-probe.json') YIELD value RETURN value`],
  ['apoc.load.jsonArray', `CALL apoc.load.jsonArray('${NOWHERE}') YIELD value RETURN value`],
  ['apoc.load.xml', `CALL apoc.load.xml('${NOWHERE}') YIELD value RETURN value`],
  ['apoc.export.json.all streamed', 'CALL apoc.export.json.all(null, {stream: true}) YIELD data RETURN data'],
  ['apoc.export.csv.all streamed', 'CALL apoc.export.csv.all(null, {stream: true}) YIELD data RETURN data'],
  [
    'apoc.export.cypher.all streamed',
    'CALL apoc.export.cypher.all(null, {stream: true}) YIELD cypherStatements RETURN cypherStatements',
  ],
  ['apoc.export.graphml.all streamed', 'CALL apoc.export.graphml.all(null, {stream: true}) YIELD data RETURN data'],
  [
    'apoc.export.json.query to a file',
    "CALL apoc.export.json.query('MATCH (n) RETURN n', 'file:///grc-outside-probe.json', {}) YIELD file RETURN file",
  ],
  ['apoc.spatial.sortByDistance', 'CALL apoc.spatial.sortByDistance([]) YIELD path RETURN path'],
];

/** Procedures that write to the graph: run in a WRITE session, so read-only mode can't be the reason. */
const IMPORT_PROCEDURES: [string, string][] = [
  ['apoc.import.json', "CALL apoc.import.json('file:///grc-outside-probe.json')"],
  ['apoc.import.csv', "CALL apoc.import.csv([{fileName: 'file:///grc-outside-probe.csv', labels: ['X']}], [], {})"],
  ['apoc.import.graphml', "CALL apoc.import.graphml('file:///grc-outside-probe.graphml', {})"],
  ['apoc.import.xml', "CALL apoc.import.xml('file:///grc-outside-probe.xml')"],
];

const OUTSIDE_PREFIXES = ['apoc.load.', 'apoc.import.', 'apoc.export.', 'apoc.bolt.', 'apoc.spatial.'];

let sup: Driver;
let graph: QueryGraph | undefined;
let org: FixtureOrg;

beforeAll(async () => {
  sup = superDriver();
  runSetupNeo4j();
  const orgId = randomUUID();
  const database = `org-${orgId}`;
  await runOn(sup, 'system', `CREATE DATABASE \`${database}\` IF NOT EXISTS WAIT`);
  org = { orgId, database, nodes: [], rels: [], outboxIds: [] };
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

/** Runs `cypher` and returns Neo4j's error; fails the test if the query ran. */
async function errorOf(run: Runner, cypher: string): Promise<Error & { code?: string }> {
  try {
    await run(org, cypher);
  } catch (err) {
    return err as Error & { code?: string };
  }
  throw new Error(`expected a permission error, but the query ran: ${cypher}`);
}

function expectDenied(err: Error & { code?: string }, denied: RegExp, context: string): void {
  const seen = `${String(err.code)}: ${err.message}`;
  expect(err.message, `${context} tried to reach outside instead of being refused (${seen})`).not.toMatch(
    TRIED_TO_REACH,
  );
  expect(err.code, `${context}: ${seen}`).toBe(FORBIDDEN);
  expect(err.message, context).toMatch(denied);
}

async function ownPrivileges(account: Account): Promise<string[]> {
  const rows = await runOn(sup, 'system', `SHOW ROLE \`${account.name}\` PRIVILEGES AS COMMANDS`);
  return rows.map((r) => String(r['command']));
}

describe.each(ACCOUNTS)('$name cannot reach outside the database (D52.2)', (account) => {
  it('is refused LOAD CSV from an http or file:/// URL by Neo4j itself', async () => {
    const run = impersonatedRunner(sup, account, 'READ');
    expect(await run(org, 'RETURN 1 AS one'), 'the account must exist first').toEqual([{ one: 1 }]);
    for (const [what, cypher] of LOADS) expectDenied(await errorOf(run, cypher), LOAD_DENIED, `${what} as ${account.name}`);
  });

  it('is refused the apoc.load, apoc.export and apoc.spatial procedures by Neo4j itself', async () => {
    const run = impersonatedRunner(sup, account, 'READ');
    for (const [what, cypher] of READ_PROCEDURES)
      expectDenied(await errorOf(run, cypher), PROCEDURE_DENIED, `${what} as ${account.name}`);
  });

  it('is refused the apoc.import procedures by Neo4j itself, even in a write session', async () => {
    const run = impersonatedRunner(sup, account, 'WRITE');
    for (const [what, cypher] of IMPORT_PROCEDURES)
      expectDenied(await errorOf(run, cypher), PROCEDURE_DENIED, `${what} as ${account.name}`);
  });

  it('is refused LOAD CSV and apoc.load.json through GraphService.readAs', async () => {
    const run = readAsRunner(graph, account, 30_000);
    expect(await run(org, 'RETURN 1 AS one'), 'readAs must work for the account first').toEqual([{ one: 1 }]);
    expectDenied(await errorOf(run, LOADS[0]![1]), LOAD_DENIED, `LOAD CSV via readAs as ${account.name}`);
    expectDenied(await errorOf(run, LOADS[2]![1]), LOAD_DENIED, `LOAD CSV file:/// via readAs as ${account.name}`);
    expectDenied(
      await errorOf(run, READ_PROCEDURES[0]![1]),
      PROCEDURE_DENIED,
      `apoc.load.json via readAs as ${account.name}`,
    );
  });

  it('can execute none of the installed apoc.load, import, export, bolt or spatial procedures', async () => {
    const rows = await runOn(
      sup,
      'system',
      `SHOW PROCEDURES EXECUTABLE BY \`${account.name}\` YIELD name RETURN name`,
    );
    const names = rows.map((r) => String(r['name']));
    expect(names.length, 'the account must be able to execute some procedure (PUBLIC)').toBeGreaterThan(0);
    expect(names.filter((n) => OUTSIDE_PREFIXES.some((p) => n.startsWith(p)))).toEqual([]);
  });

  it('holds DENY LOAD and a DENY EXECUTE for each outside procedure family, apoc.bolt included', async () => {
    const privileges = await ownPrivileges(account);
    expect(privileges.some((p) => /^DENY LOAD ON ALL DATA TO /.test(p)), privileges.join('\n')).toBe(true);
    for (const prefix of OUTSIDE_PREFIXES) {
      const pattern = `${prefix}*`;
      expect(
        privileges.some((p) => p.startsWith('DENY EXECUTE PROCEDURE ') && p.includes(pattern) && / ON DBMS /.test(p)),
        `DENY EXECUTE PROCEDURE ${pattern} ON DBMS for ${account.name}`,
      ).toBe(true);
    }
  });
});
