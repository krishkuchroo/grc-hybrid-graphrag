// The Postgres connection (D13, D29): Drizzle over a node-postgres pool.
// At runtime the URL is DATABASE_URL_APP, the restricted grc_app account (D57, D73).
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

export type Db = NodePgDatabase & { $client: Pool };

export function createDb(url: string, opts: { max?: number } = {}): Db {
  const pool = new Pool({ connectionString: url, max: opts.max });
  return drizzle({ client: pool });
}
