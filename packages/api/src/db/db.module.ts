// The database module (D57, D73): the runtime connects only as grc_app, through
// DATABASE_URL_APP. The migration account is for drizzle-kit (drizzle.config.ts) only.
// M0-007 registers `dbProvider` in the NestJS app.
import { createDb, type Db } from './client.js';

export const DB = Symbol('DB');

export function dbFromEnv(env: NodeJS.ProcessEnv = process.env): Db {
  const url = env.DATABASE_URL_APP;
  if (!url) throw new Error('DATABASE_URL_APP is not set');
  return createDb(url);
}

export const dbProvider = { provide: DB, useFactory: (): Db => dbFromEnv() };
