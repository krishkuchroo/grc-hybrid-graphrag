// Graph access behind a small interface (D45.2). One database per org (D22).
// - grc_admin only creates org databases (D57).
// - grc_writer reads and writes, always in `org-<orgId>` (D73). Neo4j can't limit it to
//   `org-*` databases, so our code refuses Cypher that names a database with USE (D144).
// - AI graph queries run through `readAs`, as one of the 28 read-only accounts (D73, M0-005).
import neo4j, { type Driver, type ManagedTransaction, type Session } from 'neo4j-driver';
import type { Label, Role } from '@grc/shared';
import { orgDatabaseName } from './org-database.js';
import { queryAccountName, queryAccountPassword } from './query-accounts.js';
import { GraphQueryRefused, assertNoDatabaseReference } from './query-guard.js';

export { GraphQueryRefused };

export interface GraphServiceOptions {
  uri: string;
  adminPassword: string;
  writerPassword: string;
  /** NEO4J_QUERY_SECRET: the 28 read-only query accounts' passwords derive from it (M0-005). */
  querySecret?: string;
}

const ALREADY_EXISTS = 'Neo.ClientError.Database.ExistingDatabaseFound';
// Up to 28 query drivers can exist (one per account), so each keeps a small pool. Chat queues for
// Gemma, so only a few graph queries per account run at once; 28 x 5 = 140 connections at most.
const QUERY_POOL_SIZE = 5;
const ONLINE_WAIT_MS = 120_000;

/** A new org database that Neo4j did not bring online (D217). Names the database and its state only. */
export class OrgDatabaseNotOnline extends Error {
  constructor(
    readonly database: string,
    readonly state: string,
  ) {
    super(`Database ${database} did not start: ${state}`);
    this.name = 'OrgDatabaseNotOnline';
  }
}

function assertNoUse(query: unknown): void {
  const text = typeof query === 'string' ? query : (query as { text?: unknown } | null)?.text;
  assertNoDatabaseReference(text as string);
}

/** The driver's transaction, with `run` refusing any query that names a database. */
function guarded(tx: ManagedTransaction): ManagedTransaction {
  return new Proxy(tx, {
    get(target, prop) {
      if (prop === 'run') {
        return (query: Parameters<ManagedTransaction['run']>[0], params?: Parameters<ManagedTransaction['run']>[1]) => {
          assertNoUse(query);
          return target.run(query, params);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export class GraphService {
  private readonly admin: Driver;
  private readonly writer: Driver;
  private readonly uri: string;
  private readonly querySecret: string | undefined;
  private readonly query = new Map<string, Driver>();

  constructor(options: GraphServiceOptions) {
    const config = { disableLosslessIntegers: true };
    this.admin = neo4j.driver(options.uri, neo4j.auth.basic('grc_admin', options.adminPassword), config);
    this.writer = neo4j.driver(options.uri, neo4j.auth.basic('grc_writer', options.writerPassword), config);
    this.uri = options.uri;
    this.querySecret = options.querySecret;
  }

  /**
   * Creates `org-<orgId>` and checks it is online. Does nothing if it already exists. A database
   * Neo4j failed to start rejects at once with OrgDatabaseNotOnline (D217); no retries (D171).
   */
  async createOrgDatabase(orgId: string): Promise<void> {
    const name = orgDatabaseName(orgId);
    const session = this.admin.session({ database: 'system' });
    try {
      try {
        const res = await session.run('CREATE DATABASE $name IF NOT EXISTS WAIT', { name });
        // The WAIT result has one row per server: address, state, message, success.
        const failed = res.records.find((r) => r.has('success') && r.get('success') === false);
        if (failed) throw new OrgDatabaseNotOnline(name, String(failed.has('state') ? failed.get('state') : 'failed'));
      } catch (err) {
        // Another caller created it between our check and our create.
        if ((err as { code?: string }).code !== ALREADY_EXISTS) throw err;
      }
      await this.waitOnline(session, name);
    } finally {
      await session.close();
    }
  }

  /** Runs `fn` in one write transaction in `org-<orgId>`, as the writer account. */
  async write<T>(orgId: string, fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const session = this.session(orgId, neo4j.session.WRITE);
    try {
      return await session.executeWrite((tx) => fn(guarded(tx)));
    } finally {
      await session.close();
    }
  }

  /** Runs `fn` in a read transaction in `org-<orgId>`, as the writer account. */
  async read<T>(orgId: string, fn: (tx: ManagedTransaction) => Promise<T>): Promise<T> {
    const session = this.session(orgId, neo4j.session.READ);
    try {
      return await session.executeRead((tx) => fn(guarded(tx)));
    } finally {
      await session.close();
    }
  }

  /**
   * Runs `fn` in a read transaction in `org-<orgId>`, as the read-only account for `role` and
   * `clearance` (D52.2, D73), stopped by Neo4j after `timeoutMs`. Queries naming a database are
   * refused before they are sent (D131).
   */
  async readAs<T>(
    orgId: string,
    role: Role,
    clearance: Label,
    fn: (tx: ManagedTransaction) => Promise<T>,
    options: { timeoutMs: number },
  ): Promise<T> {
    const database = orgDatabaseName(orgId);
    const timeout = options?.timeoutMs;
    if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout <= 0) {
      throw new Error('readAs needs a positive whole timeoutMs');
    }
    const session = this.queryDriver(role, clearance).session({ database, defaultAccessMode: neo4j.session.READ });
    try {
      return await session.executeRead((tx) => fn(guarded(tx)), { timeout });
    } finally {
      await session.close();
    }
  }

  /** Checks that Neo4j answers and accepts the writer account (the health route). */
  async ping(): Promise<void> {
    await this.writer.verifyConnectivity();
  }

  async close(): Promise<void> {
    const query = [...this.query.values()];
    this.query.clear();
    await Promise.all([this.admin.close(), this.writer.close(), ...query.map((d) => d.close())]);
  }

  /**
   * One driver per query account, logged in as that account and made on first use (TEST-007).
   * A shared driver with a login per session re-logs pooled connections in as another account,
   * which Neo4j's Bolt server can drop mid-login ("Connection was closed by server").
   */
  private queryDriver(role: Role, clearance: Label): Driver {
    const user = queryAccountName(role, clearance);
    let driver = this.query.get(user);
    if (!driver) {
      const auth = neo4j.auth.basic(user, queryAccountPassword(this.querySecret ?? '', role, clearance));
      driver = neo4j.driver(this.uri, auth, { disableLosslessIntegers: true, maxConnectionPoolSize: QUERY_POOL_SIZE });
      this.query.set(user, driver);
    }
    return driver;
  }

  private session(orgId: string, mode: typeof neo4j.session.READ | typeof neo4j.session.WRITE): Session {
    return this.writer.session({ database: orgDatabaseName(orgId), defaultAccessMode: mode });
  }

  /** Only `starting` is checked again; any other status than `online` fails at once (D217). */
  private async waitOnline(session: Session, name: string): Promise<void> {
    const deadline = Date.now() + ONLINE_WAIT_MS;
    for (;;) {
      const res = await session.run('SHOW DATABASE $name YIELD currentStatus', { name });
      const statuses = res.records.map((r) => String(r.get('currentStatus')));
      if (statuses.length === 0) throw new OrgDatabaseNotOnline(name, 'not listed');
      const bad = statuses.find((s) => s !== 'online' && s !== 'starting');
      if (bad !== undefined) throw new OrgDatabaseNotOnline(name, bad);
      if (statuses.every((s) => s === 'online')) return;
      if (Date.now() > deadline) throw new OrgDatabaseNotOnline(name, 'starting');
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
