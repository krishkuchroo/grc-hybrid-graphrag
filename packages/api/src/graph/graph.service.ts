// Graph access behind a small interface (D45.2). One database per org (D22).
// - grc_admin only creates org databases (D57).
// - grc_writer reads and writes, always in `org-<orgId>` (D73). Neo4j can't limit it to
//   `org-*` databases, so our code refuses Cypher that names a database with USE (D144).
import neo4j, { type Driver, type ManagedTransaction, type Session } from 'neo4j-driver';
import { orgDatabaseName } from './org-database.js';

export interface GraphServiceOptions {
  uri: string;
  adminPassword: string;
  writerPassword: string;
}

export class GraphQueryRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GraphQueryRefused';
  }
}

const ALREADY_EXISTS = 'Neo.ClientError.Database.ExistingDatabaseFound';
const ONLINE_WAIT_MS = 120_000;

// Strings, quoted names and comments can't name a database, so they are dropped before the check.
const NOT_CODE = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`]|``)*`|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g;

function assertNoUse(query: unknown): void {
  const text = typeof query === 'string' ? query : (query as { text?: unknown } | null)?.text;
  if (typeof text !== 'string') throw new GraphQueryRefused('Graph query must be text');
  if (/\bUSE\b/i.test(text.replace(NOT_CODE, ' '))) {
    throw new GraphQueryRefused('Graph queries may not name a database (USE)');
  }
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

  constructor(options: GraphServiceOptions) {
    const config = { disableLosslessIntegers: true };
    this.admin = neo4j.driver(options.uri, neo4j.auth.basic('grc_admin', options.adminPassword), config);
    this.writer = neo4j.driver(options.uri, neo4j.auth.basic('grc_writer', options.writerPassword), config);
  }

  /** Creates `org-<orgId>` and waits until it is online. Does nothing if it already exists. */
  async createOrgDatabase(orgId: string): Promise<void> {
    const name = orgDatabaseName(orgId);
    const session = this.admin.session({ database: 'system' });
    try {
      try {
        await session.run('CREATE DATABASE $name IF NOT EXISTS WAIT', { name });
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

  async close(): Promise<void> {
    await Promise.all([this.admin.close(), this.writer.close()]);
  }

  private session(orgId: string, mode: typeof neo4j.session.READ | typeof neo4j.session.WRITE): Session {
    return this.writer.session({ database: orgDatabaseName(orgId), defaultAccessMode: mode });
  }

  private async waitOnline(session: Session, name: string): Promise<void> {
    const deadline = Date.now() + ONLINE_WAIT_MS;
    for (;;) {
      const res = await session.run('SHOW DATABASE $name YIELD currentStatus', { name });
      const statuses = res.records.map((r) => String(r.get('currentStatus')));
      if (statuses.length > 0 && statuses.every((s) => s === 'online')) return;
      if (Date.now() > deadline) throw new Error(`Database ${name} did not come online in time`);
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
}
