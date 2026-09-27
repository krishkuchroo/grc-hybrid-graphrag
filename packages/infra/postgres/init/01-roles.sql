-- The two Postgres accounts (D57, D73). Runs once, as the postgres superuser, when the
-- grc-postgres data volume is first created (docker-entrypoint-initdb.d, run by psql).
-- The passwords come from DATABASE_URL_APP and DATABASE_URL_MIGRATE, which compose passes
-- in from the git-ignored .env (setup:secrets writes them). Nothing secret is stored here.
--   grc_app       the restricted runtime account: no superuser, no RLS bypass, owns nothing.
--   grc_migrator  runs the migrations (drizzle-kit) and owns every table; never used at runtime.
\set ON_ERROR_STOP on
\getenv app_url DATABASE_URL_APP
\getenv migrate_url DATABASE_URL_MIGRATE

SELECT substring(:'app_url' from '^postgres(?:ql)?://grc_app:([^@/]+)@') AS app_password,
       substring(:'migrate_url' from '^postgres(?:ql)?://grc_migrator:([^@/]+)@') AS migrate_password
\gset

SELECT (:'app_password' <> '' AND :'migrate_password' <> '') AS urls_ok \gset
\if :urls_ok
\else
DO $$ BEGIN
  RAISE EXCEPTION '01-roles.sql: DATABASE_URL_APP must be postgres://grc_app:<password>@… and DATABASE_URL_MIGRATE postgres://grc_migrator:<password>@…';
END $$;
\endif

SELECT format(
  'CREATE ROLE grc_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'app_password'
) \gexec
SELECT format(
  'CREATE ROLE grc_migrator LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD %L',
  :'migrate_password'
) \gexec

-- The app database. The migration account owns the database it migrates.
CREATE DATABASE grc OWNER grc_migrator;
