// M0-005 criterion 7 (D131, D138): our code refuses any AI-written graph query that names a
// database, before anything is sent to Neo4j.
//
// Contract: packages/api/src/graph/query-guard.ts exports
// - `GraphQueryRefused` (an Error whose `name` is 'GraphQueryRefused'), and
// - `assertNoDatabaseReference(cypher: string): void`, which throws GraphQueryRefused when the
//   text names a database in any form (a USE clause in any letter case or spacing, including
//   inside a subquery or after UNION; a composite or database-qualified name; graph.byName /
//   graph.byElementId; a backtick-quoted database name), and returns quietly for ordinary read
//   queries that don't. Anything that isn't a string is refused too (fail safe).
// These tests need no database: the guard is plain code that runs before any query is sent.
import { describe, expect, it } from 'vitest';
import { loadAssertNoDatabaseReference, loadGraphQueryRefused } from './helpers.js';

const B = '7d0c6a52-3f1e-4c8b-9a57-2b8e1f4d6c90';

const REFUSED: [string, string][] = [
  ['USE with a backtick-quoted org database', `USE \`org-${B}\` MATCH (n) RETURN n`],
  ['USE with an unquoted name', `USE org-b MATCH (n) RETURN n`],
  ['USE with a plain name', `USE neo4j MATCH (n) RETURN n`],
  ['USE with the system database', `USE system SHOW USERS`],
  ['lower-case use', `use \`org-${B}\` match (n) return n`],
  ['mixed-case uSe', `uSe \`org-${B}\` MATCH (n) RETURN n`],
  ['USE after leading spaces and new lines', `\n\t   USE \`org-${B}\`\nMATCH (n) RETURN n`],
  ['USE split over lines', `USE\n\`org-${B}\`\nMATCH (n)\nRETURN n`],
  ['USE with tabs between', `USE\t\t\`org-${B}\`\tMATCH (n) RETURN n`],
  ['USE with no space before the quoted name', `USE\`org-${B}\` MATCH (n) RETURN n`],
  ['USE with a comment before the name', `USE /* x */ \`org-${B}\` MATCH (n) RETURN n`],
  ['USE with a comment and no spaces', `USE/**/\`org-${B}\` MATCH (n) RETURN n`],
  ['USE inside a CALL subquery', `MATCH (a:Asset) CALL { USE \`org-${B}\` MATCH (n) RETURN n } RETURN a, n`],
  ['USE inside a scoped CALL subquery', `MATCH (a:Asset) CALL (a) { USE \`org-${B}\` MATCH (n) RETURN n } RETURN a, n`],
  ['USE inside a subquery with no spaces', `CALL {USE \`org-${B}\` MATCH (n) RETURN n} RETURN n`],
  ['USE inside a lower-case subquery', `call { use \`org-${B}\` match (n) return n } return n`],
  ['USE after UNION', `MATCH (n:Asset) RETURN n UNION USE \`org-${B}\` MATCH (n) RETURN n`],
  ['USE after a CYPHER version prefix', `CYPHER 25 USE \`org-${B}\` MATCH (n) RETURN n`],
  ['USE after EXPLAIN', `EXPLAIN USE \`org-${B}\` MATCH (n) RETURN n`],
  ['USE after PROFILE', `PROFILE USE \`org-${B}\` MATCH (n) RETURN n`],
  ['USE with a composite database-qualified name', `USE grc.\`org-${B}\` MATCH (n) RETURN n`],
  ['USE with a backtick-quoted qualified name', `USE \`grc\`.\`org-${B}\` MATCH (n) RETURN n`],
  ['USE graph.byName', `USE graph.byName('org-${B}') MATCH (n) RETURN n`],
  [
    'USE graph.byName in a subquery',
    `UNWIND ['org-${B}'] AS g CALL (g) { USE graph.byName(g) MATCH (n) RETURN n } RETURN n`,
  ],
  ['USE graph.byElementId', `USE graph.byElementId('4:${B}:0') MATCH (n) RETURN n`],
  ['USE with a trailing semicolon statement', `MATCH (n) RETURN n;\nUSE \`org-${B}\` MATCH (m) RETURN m`],
];

const ALLOWED: [string, string][] = [
  ['a risk and its controls', 'MATCH (r:Risk)-[:MITIGATED_BY]->(c:Control) RETURN r.name, c.name LIMIT 25'],
  [
    'counting risks per asset',
    'MATCH (a:Asset)-[:EXPOSED_TO]->(r:Risk) WITH a, count(r) AS n RETURN a.name, n ORDER BY n DESC',
  ],
  ['a status of "in use"', "MATCH (a:Asset) WHERE a.status = 'in use' RETURN a.name"],
  ['the Acceptable Use Policy', "MATCH (p:Policy) WHERE p.name CONTAINS 'Acceptable Use' RETURN p.name"],
  ['a variable called user', 'MATCH (user:Asset) RETURN user.name AS used_by'],
  ['properties with use in their names', "MATCH (c:Control) WHERE c.code STARTS WITH 'AC-' RETURN c.code, c.useCase"],
  [
    'a subquery that names no database',
    'MATCH (a:Asset) CALL (a) { MATCH (a)-[:EXPOSED_TO]->(r:Risk) RETURN r } RETURN a, r',
  ],
  ['UNION with no database', 'MATCH (n:Asset) RETURN n.name AS name UNION MATCH (n:Risk) RETURN n.name AS name'],
  ['a backtick-quoted label and property', 'MATCH (n:`Asset`) RETURN n.`name`'],
  ['a parameter', 'MATCH (i:Incident {id: $id})-[:IMPACTS]->(a:Asset) RETURN a.name'],
  ['a variable-length path', 'MATCH p = (a:Asset)-[*1..3]-(c:Control) RETURN length(p) LIMIT 10'],
  [
    'OPTIONAL MATCH and aggregation',
    'MATCH (c:Control) OPTIONAL MATCH (c)<-[:SATISFIES]-(e:Evidence) RETURN c.code, count(e)',
  ],
];

describe('assertNoDatabaseReference refuses queries that name a database (criterion 7, D131)', () => {
  it.each(REFUSED)('refuses %s', async (_what, cypher) => {
    const assertNoDatabaseReference = await loadAssertNoDatabaseReference();
    const GraphQueryRefused = await loadGraphQueryRefused();
    let thrown: unknown;
    try {
      assertNoDatabaseReference(cypher);
    } catch (err) {
      thrown = err;
    }
    expect(thrown, cypher).toBeInstanceOf(GraphQueryRefused);
    expect((thrown as Error).name).toBe('GraphQueryRefused');
  });

  it.each([undefined, null, 42, ['MATCH (n) RETURN n'], { text: 'MATCH (n) RETURN n' }])(
    'refuses a query that is not text (%j)',
    async (value) => {
      const assertNoDatabaseReference = await loadAssertNoDatabaseReference();
      const GraphQueryRefused = await loadGraphQueryRefused();
      expect(() => assertNoDatabaseReference(value as unknown as string)).toThrow(GraphQueryRefused);
    },
  );
});

describe('assertNoDatabaseReference lets ordinary read queries through (criterion 7)', () => {
  it.each(ALLOWED)('allows %s', async (_what, cypher) => {
    const assertNoDatabaseReference = await loadAssertNoDatabaseReference();
    expect(() => assertNoDatabaseReference(cypher)).not.toThrow();
    expect(assertNoDatabaseReference(cypher)).toBeUndefined();
  });
});

describe('GraphQueryRefused', () => {
  it('is an Error named GraphQueryRefused', async () => {
    const GraphQueryRefused = await loadGraphQueryRefused();
    const err = new GraphQueryRefused('x');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('GraphQueryRefused');
  });
});
