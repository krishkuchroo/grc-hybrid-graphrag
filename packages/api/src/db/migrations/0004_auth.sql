-- M0-010 (D49, D54, D55): what sign-in needs on top of the M0-009 tables. Runs as grc_migrator.

-- Whether this session finished the second factor (TOTP or a backup code). Only sessions made by
-- the two-factor verify routes have it set; the SessionGuard refuses the others (D54).
ALTER TABLE "session" ADD COLUMN "mfa_verified" boolean NOT NULL DEFAULT false;
--> statement-breakpoint

-- The columns Better Auth's 2FA plugin keeps per user: whether the TOTP secret was confirmed with
-- a code, and its own lock on repeated wrong codes.
ALTER TABLE "two_factor" ADD COLUMN "verified" boolean DEFAULT true;
--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN "failed_verification_count" integer DEFAULT 0;
--> statement-breakpoint
ALTER TABLE "two_factor" ADD COLUMN "locked_until" timestamptz;
--> statement-breakpoint

-- A user's own memberships, for the SessionGuard and the sign-in audit before any org context
-- exists. `member` sits behind the org wall, so this reads it as the owner (SECURITY DEFINER) and
-- returns only the rows of the one user asked about. Oldest membership first.
CREATE FUNCTION app_user_memberships(uid text)
  RETURNS TABLE (org_id uuid, role text, clearance text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
  SELECT m.org_id, m.role, m.clearance FROM public.member m
  WHERE uid IS NOT NULL AND m.user_id = uid
  ORDER BY m.created_at, m.id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_user_memberships(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_user_memberships(text) TO grc_app;
--> statement-breakpoint
-- The function runs as grc_migrator, which FORCE RLS also covers: a read-only policy for it.
-- grc_app gets nothing from it.
CREATE POLICY "member_definer_read" ON "member" FOR SELECT TO grc_migrator USING (true);
