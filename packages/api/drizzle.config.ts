// drizzle-kit runs the migrations as grc_migrator (D57). Runtime code never reads
// DATABASE_URL_MIGRATE; it connects as grc_app (src/db/db.module.ts).
import { defineConfig } from 'drizzle-kit';

const url = process.env.DATABASE_URL_MIGRATE;
if (!url) throw new Error('DATABASE_URL_MIGRATE is not set');

export default defineConfig({
  dialect: 'postgresql',
  out: './src/db/migrations',
  dbCredentials: { url },
});
