// TEST-007: `GraphService.readAs` never logs a Bolt connection in again as a different account.
// Decisions: D52.2 and D73 (AI graph queries run as one of the 28 read-only accounts), D131,
// D171 (a test that fails then passes is a bug), D176.
//
// Why (the cause of the flaky "grc_ro_auditor_restricted ... logs in through GraphService.readAs"):
// - readAs (src/graph/graph.service.ts:116-117) runs every account's session on one shared driver
//   with a per-session login. When a pooled connection last served another account, neo4j-driver
//   6.2.0 logs it off and on again in place (connection-channel.js:305-306: LOGOFF, LOGON, flush,
//   without waiting), so the transaction's BEGIN and RUN follow right behind the LOGON.
// - Neo4j's Bolt server has a race on that path. The DBMS's debug.log, 2026-09-28 14:44:23.229:
//   "Fatal error occurred when handling a client connection ... NullPointerException: Cannot invoke
//   AuthenticationTimeoutHandler.setRequestReceived(boolean) because this.timeoutHandler is null
//   (AuthenticationTimeoutConnectionListener.java:74)". The same connection (client port 51938)
//   had just served grc_ro_auditor_confidential, and security.log shows grc_ro_auditor_restricted
//   "logged in" at the same millisecond: the LOGON succeeded, the next request hit the NPE, and the
//   server closed the connection ("Connection was closed by server" in BoltProtocol._onLoginError).
// - No failed login for any grc_ro_* account appears in any security.log, so it isn't lockout.
// - A real user hits it the same way: every AI graph query (chat Path B) goes through readAs, and
//   people with different roles and clearances share that one driver's pool.
//
// Contract: every Bolt connection that readAs uses is only ever logged in as one account. Checked
// from the DBMS side: while each readAs transaction is open, the Desktop account lists it with
// SHOW TRANSACTIONS and notes its connection. No connection may serve two accounts.
//
// Needs the running Neo4j Desktop DBMS (bolt://127.0.0.1:7687). The accounts come from
// `pnpm setup:neo4j`, which `pnpm test:env` checks first (their DENY rules).
import type { Driver } from 'neo4j-driver';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ACCOUNTS,
  LONG,
  createFixtureOrg,
  dropDatabases,
  newGraph,
  requireReadAs,
  runOn,
  superDriver,
  type Account,
  type FixtureOrg,
  type QueryGraph,
} from './helpers.js';

let sup: Driver;
let graph: QueryGraph | undefined;
let org: FixtureOrg;

beforeAll(async () => {
  sup = superDriver();
  org = await createFixtureOrg(sup);
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

/** Runs `RETURN 1` through readAs as `account`, and returns the Bolt connection it ran on. */
async function connectionOf(account: Account): Promise<string[]> {
  return requireReadAs(graph).readAs(
    org.orgId,
    account.role,
    account.clearance,
    async (tx) => {
      await tx.run('RETURN 1 AS one');
      const rows = await runOn(
        sup,
        'system',
        `SHOW TRANSACTIONS YIELD database, username, connectionId
         WHERE database = $db AND username = $user RETURN connectionId`,
        { db: org.database, user: account.name },
      );
      return rows.map((r) => String(r['connectionId']));
    },
    { timeoutMs: 30_000 },
  );
}

describe('GraphService.readAs keeps one account per Bolt connection (TEST-007)', () => {
  it(
    'never logs a pooled connection in again as another account, over two rounds of all 28',
    async () => {
      const usersByConnection = new Map<string, Set<string>>();
      for (const round of [1, 2]) {
        for (const account of ACCOUNTS) {
          const ids = await connectionOf(account);
          expect(ids, `round ${round}: ${account.name}'s open readAs transaction, seen by the DBMS`).toHaveLength(1);
          const id = ids[0]!;
          const users = usersByConnection.get(id) ?? new Set<string>();
          users.add(account.name);
          usersByConnection.set(id, users);
        }
      }
      const shared = [...usersByConnection]
        .filter(([, users]) => users.size > 1)
        .map(([id, users]) => `${id}: ${[...users].sort().join(', ')}`);
      expect(shared, 'Bolt connections that readAs logged in as more than one account').toEqual([]);
    },
    LONG,
  );
});
