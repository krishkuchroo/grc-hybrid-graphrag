-- M0-011 (D11, D54, D56, D73): machine API keys. Runs as grc_migrator.
-- One org and one role per key, with an expiry; revocable. Only the SHA-256 of the key is kept,
-- so the plain key can't be read back. An org table (M0-009 rule): `org_id uuid not null`, RLS
-- enabled and forced, the standard policy (src/db/rls.sql.ts).
CREATE TABLE "api_keys" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "name" text NOT NULL,
  "role" text NOT NULL,
  "key_hash" text NOT NULL UNIQUE,
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_by" text NOT NULL REFERENCES "user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "api_keys_role_check" CHECK ("role" IN ('admin', 'risk_manager', 'compliance_manager', 'control_owner', 'auditor', 'analyst', 'viewer'))
);
--> statement-breakpoint
CREATE INDEX "api_keys_org_idx" ON "api_keys" ("org_id", "created_at");
--> statement-breakpoint
ALTER TABLE "api_keys" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "api_keys" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "api_keys_org_select" ON "api_keys" FOR SELECT TO grc_app USING (app_visible_org("org_id"));
--> statement-breakpoint
CREATE POLICY "api_keys_org_insert" ON "api_keys" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "api_keys_org_update" ON "api_keys" FOR UPDATE TO grc_app USING ("org_id" = app_org_id()) WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "api_keys_org_delete" ON "api_keys" FOR DELETE TO grc_app USING ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "api_keys" TO grc_app;
--> statement-breakpoint

-- The key a request presents, found by its hash before any org context exists (the key decides
-- the org). `api_keys` sits behind the org wall, so this reads it as the owner (SECURITY DEFINER)
-- and returns at most the one row whose hash matches.
CREATE FUNCTION app_api_key_by_hash(h text)
  RETURNS TABLE (id uuid, org_id uuid, role text, expires_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
  SELECT k.id, k.org_id, k.role, k.expires_at, k.revoked_at FROM public.api_keys k
  WHERE h IS NOT NULL AND k.key_hash = h
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_api_key_by_hash(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_api_key_by_hash(text) TO grc_app;
--> statement-breakpoint
-- The function runs as grc_migrator, which FORCE RLS also covers: a read-only policy for it.
-- grc_app gets nothing from it.
CREATE POLICY "api_keys_definer_read" ON "api_keys" FOR SELECT TO grc_migrator USING (true);
