-- M0-009 (D4, D9, D49, D55, D57, D73): identity and grant tables, and the org wall in Postgres.
-- Runs as grc_migrator, which owns every table; grc_app gets row rights by name only.
-- The org-table policy blocks follow `orgTablePolicySql` in src/db/rls.sql.ts.

-- Better Auth tables (src/identity/schema.ts).
CREATE TABLE "user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "email_verified" boolean NOT NULL DEFAULT false,
  "image" text,
  "two_factor_enabled" boolean DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "session" (
  "id" text PRIMARY KEY,
  "expires_at" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "ip_address" text,
  "user_agent" text,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "active_organization_id" uuid
);
--> statement-breakpoint
CREATE TABLE "account" (
  "id" text PRIMARY KEY,
  "account_id" text NOT NULL,
  "provider_id" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE,
  "access_token" text,
  "refresh_token" text,
  "id_token" text,
  "access_token_expires_at" timestamptz,
  "refresh_token_expires_at" timestamptz,
  "scope" text,
  "password" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "two_factor" (
  "id" text PRIMARY KEY,
  "secret" text NOT NULL,
  "backup_codes" text NOT NULL,
  "user_id" text NOT NULL REFERENCES "user"("id") ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE "organization" (
  "id" uuid PRIMARY KEY,
  "name" text NOT NULL,
  "slug" text NOT NULL UNIQUE,
  "logo" text,
  "metadata" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
-- Org tables never cascade from "user": a cascade runs without RLS.
CREATE TABLE "member" (
  "id" text PRIMARY KEY,
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "user_id" text NOT NULL REFERENCES "user"("id"),
  "role" text NOT NULL,
  "clearance" text NOT NULL DEFAULT 'internal',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "member_role_check" CHECK ("role" IN ('admin', 'risk_manager', 'compliance_manager', 'control_owner', 'auditor', 'analyst', 'viewer')),
  CONSTRAINT "member_clearance_check" CHECK ("clearance" IN ('public', 'internal', 'confidential', 'restricted'))
);
--> statement-breakpoint
CREATE TABLE "invitation" (
  "id" text PRIMARY KEY,
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "email" text NOT NULL,
  "role" text,
  "status" text NOT NULL DEFAULT 'pending',
  "expires_at" timestamptz NOT NULL,
  "inviter_id" text NOT NULL REFERENCES "user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Cross-org access (src/identity/grants.schema.ts, D55).
CREATE TABLE "auditor_grants" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "user_id" text NOT NULL REFERENCES "user"("id"),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "parent_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "parent_org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "status" text NOT NULL DEFAULT 'requested',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "parent_links_status_check" CHECK ("status" IN ('requested', 'approved', 'ended')),
  CONSTRAINT "parent_links_not_self_check" CHECK ("org_id" <> "parent_org_id")
);
--> statement-breakpoint
CREATE TABLE "break_glass_sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "user_id" text NOT NULL REFERENCES "user"("id"),
  "reason" text NOT NULL,
  "expires_at" timestamptz NOT NULL,
  "ended_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- The org in this transaction's context, or null when none is set (fail safe: no rows).
CREATE FUNCTION app_org_id() RETURNS uuid
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
  AS $$ SELECT nullif(current_setting('app.org_id', true), '')::uuid $$;
--> statement-breakpoint
-- True for the context org, or for an org the context user may read through an active,
-- unexpired, unrevoked auditor grant, an approved parent link to the context org, or an open
-- break-glass session. False with no org context. SECURITY DEFINER (owner grc_migrator), so
-- reading the grant tables doesn't re-enter their own grc_app policies.
CREATE FUNCTION app_visible_org(org uuid) RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
  SELECT coalesce(
    org IS NOT NULL AND public.app_org_id() IS NOT NULL AND (
      org = public.app_org_id()
      OR EXISTS (
        SELECT 1 FROM public.auditor_grants g
        WHERE g.org_id = org
          AND g.user_id = nullif(current_setting('app.user_id', true), '')
          AND g.revoked_at IS NULL
          AND g.expires_at > now()
      )
      OR EXISTS (
        SELECT 1 FROM public.parent_links l
        WHERE l.org_id = org
          AND l.parent_org_id = public.app_org_id()
          AND l.status = 'approved'
      )
      OR EXISTS (
        SELECT 1 FROM public.break_glass_sessions b
        WHERE b.org_id = org
          AND b.user_id = nullif(current_setting('app.user_id', true), '')
          AND b.ended_at IS NULL
          AND b.expires_at > now()
      )
    ),
    false
  )
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_org_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_visible_org(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_org_id() TO grc_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_visible_org(uuid) TO grc_app;
--> statement-breakpoint

-- Tables outside the org wall: Better Auth's per-user tables.
GRANT SELECT, INSERT, UPDATE, DELETE ON "user", "session", "account", "verification", "two_factor" TO grc_app;
--> statement-breakpoint

-- The org wall: the standard policy on every org table (orgTablePolicySql).
ALTER TABLE "organization" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "organization" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "organization_org_select" ON "organization" FOR SELECT TO grc_app USING (app_visible_org("id"));
--> statement-breakpoint
CREATE POLICY "organization_org_insert" ON "organization" FOR INSERT TO grc_app WITH CHECK ("id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "organization_org_update" ON "organization" FOR UPDATE TO grc_app USING ("id" = app_org_id()) WITH CHECK ("id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "organization_org_delete" ON "organization" FOR DELETE TO grc_app USING ("id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "organization" TO grc_app;
--> statement-breakpoint
ALTER TABLE "member" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "member" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "member_org_select" ON "member" FOR SELECT TO grc_app USING (app_visible_org("org_id"));
--> statement-breakpoint
CREATE POLICY "member_org_insert" ON "member" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "member_org_update" ON "member" FOR UPDATE TO grc_app USING ("org_id" = app_org_id()) WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "member_org_delete" ON "member" FOR DELETE TO grc_app USING ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "member" TO grc_app;
--> statement-breakpoint
ALTER TABLE "invitation" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "invitation" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "invitation_org_select" ON "invitation" FOR SELECT TO grc_app USING (app_visible_org("org_id"));
--> statement-breakpoint
CREATE POLICY "invitation_org_insert" ON "invitation" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "invitation_org_update" ON "invitation" FOR UPDATE TO grc_app USING ("org_id" = app_org_id()) WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "invitation_org_delete" ON "invitation" FOR DELETE TO grc_app USING ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "invitation" TO grc_app;
--> statement-breakpoint
ALTER TABLE "auditor_grants" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "auditor_grants" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "auditor_grants_org_select" ON "auditor_grants" FOR SELECT TO grc_app USING (app_visible_org("org_id"));
--> statement-breakpoint
CREATE POLICY "auditor_grants_org_insert" ON "auditor_grants" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "auditor_grants_org_update" ON "auditor_grants" FOR UPDATE TO grc_app USING ("org_id" = app_org_id()) WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "auditor_grants_org_delete" ON "auditor_grants" FOR DELETE TO grc_app USING ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "auditor_grants" TO grc_app;
--> statement-breakpoint
ALTER TABLE "parent_links" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "parent_links" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "parent_links_org_select" ON "parent_links" FOR SELECT TO grc_app USING (app_visible_org("org_id"));
--> statement-breakpoint
CREATE POLICY "parent_links_org_insert" ON "parent_links" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "parent_links_org_update" ON "parent_links" FOR UPDATE TO grc_app USING ("org_id" = app_org_id()) WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "parent_links_org_delete" ON "parent_links" FOR DELETE TO grc_app USING ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "parent_links" TO grc_app;
--> statement-breakpoint
ALTER TABLE "break_glass_sessions" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "break_glass_sessions" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "break_glass_sessions_org_select" ON "break_glass_sessions" FOR SELECT TO grc_app USING (app_visible_org("org_id"));
--> statement-breakpoint
CREATE POLICY "break_glass_sessions_org_insert" ON "break_glass_sessions" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "break_glass_sessions_org_update" ON "break_glass_sessions" FOR UPDATE TO grc_app USING ("org_id" = app_org_id()) WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "break_glass_sessions_org_delete" ON "break_glass_sessions" FOR DELETE TO grc_app USING ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "break_glass_sessions" TO grc_app;
--> statement-breakpoint

-- app_visible_org runs as the table owner, grc_migrator, which FORCE RLS also covers. These
-- read-only policies let it read the grant tables; grc_app gets nothing from them.
CREATE POLICY "auditor_grants_definer_read" ON "auditor_grants" FOR SELECT TO grc_migrator USING (true);
--> statement-breakpoint
CREATE POLICY "parent_links_definer_read" ON "parent_links" FOR SELECT TO grc_migrator USING (true);
--> statement-breakpoint
CREATE POLICY "break_glass_sessions_definer_read" ON "break_glass_sessions" FOR SELECT TO grc_migrator USING (true);
