-- M0-003 (D13, D57, D71): extensions. Runs as grc_migrator through drizzle-kit.
-- The cluster roles grc_app and grc_migrator come from packages/infra/postgres/init/01-roles.sql.
-- grc_app gets no rights here; later migrations grant it table rights by name.
CREATE EXTENSION IF NOT EXISTS vector;
