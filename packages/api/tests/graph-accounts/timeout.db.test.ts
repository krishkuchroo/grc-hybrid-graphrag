// M0-005 criterion 6: a query that runs past `timeoutMs` is stopped.
// Decisions: D52.2 (AI-written graph queries run with a time limit), D48 (chat time targets).
//
// Contract: `GraphService.readAs(orgId, role, clearance, fn, { timeoutMs })` runs `fn` in a read
// transaction whose timeout is `timeoutMs`. A query that needs far longer (about 3 minutes here)
// is rejected with Neo4j's transaction-timeout error soon after `timeoutMs`, and Neo4j is no
// longer running it afterwards. A query that fits in the limit returns normally.
//
// Needs the running Neo4j Desktop DBMS (bolt://127.0.0.1:7687).
import { randomUUID } from 'node:crypto';
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  LONG,
  createFixtureOrg,
  ThrowawayDatabases,
  newGraph,
  requireReadAs,
  runOn,
  runSetupNeo4j,
  superDriver,
  type FixtureOrg,
  type QueryGraph,
} from './helpers.js';

let sup: Driver;
let databases: ThrowawayDatabases;
let graph: QueryGraph | undefined;
let org: FixtureOrg;

// ~10^10 rows: minutes of work on this Mac, so only a timeout can end it quickly.
const slowQuery = (marker: string): string =>
  `UNWIND range(1, 10000000000) AS x WITH x WHERE x = -1 RETURN count(x) AS n, '${marker}' AS marker`;

beforeAll(async () => {
  sup = superDriver();
  databases = new ThrowawayDatabases(sup);
  runSetupNeo4j();
  org = await createFixtureOrg(sup, databases);
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

async function stillRunning(marker: string): Promise<number> {
  const rows = await runOn(
    sup,
    org.database,
    'SHOW TRANSACTIONS YIELD currentQuery, status WHERE currentQuery CONTAINS $marker RETURN count(*) AS n',
    { marker },
  );
  return Number(rows[0]?.['n'] ?? 0);
}

const SAMPLE = ACCOUNTS.filter((a) =>
  ['grc_ro_admin_restricted', 'grc_ro_viewer_public', 'grc_ro_analyst_confidential'].includes(a.name),
);

describe.each(SAMPLE)('$name through readAs (criterion 6)', (account) => {
  it('stops a query that runs past timeoutMs', { timeout: 60_000 }, async () => {
    const marker = `grc-timeout-${randomUUID()}`;
    const started = Date.now();
    let error: (Error & { code?: string }) | undefined;
    try {
      await requireReadAs(graph).readAs(
        org.orgId,
        account.role,
        account.clearance,
        async (tx) => (await tx.run(slowQuery(marker))).records.length,
        { timeoutMs: 1_000 },
      );
    } catch (err) {
      error = err as Error & { code?: string };
    }
    const elapsed = Date.now() - started;
    expect(error, 'the slow query must be stopped').toBeDefined();
    expect(String(error?.code)).toMatch(/^Neo\.ClientError\.Transaction\.TransactionTimedOut/);
    expect(elapsed).toBeLessThan(15_000);
    // Neo4j itself has ended it.
    await new Promise((r) => setTimeout(r, 500));
    expect(await stillRunning(marker)).toBe(0);
  });

  it('lets a query that fits in timeoutMs finish', async () => {
    const n = await requireReadAs(graph).readAs(
      org.orgId,
      account.role,
      account.clearance,
      async (tx) => (await tx.run('UNWIND range(1, 1000) AS x RETURN count(x) AS n')).records[0]?.get('n') as number,
      { timeoutMs: 10_000 },
    );
    expect(n).toBe(1000);
  });
});
