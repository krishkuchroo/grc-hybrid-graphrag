-- S3-023 (D230, changes D54; D51, D57, D73): each API key carries its own clearance, picked by the
-- Admin who makes it (never above the Admin's own, checked by the API). Runs as grc_migrator.
-- Keys made before this migration keep `internal`, the clearance every key signed in at until now.
ALTER TABLE "api_keys" ADD COLUMN "clearance" text NOT NULL DEFAULT 'internal';
--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_clearance_check" CHECK ("clearance" IN ('public', 'internal', 'confidential', 'restricted'));
--> statement-breakpoint

-- The key lookup now returns the key's clearance too. Its result columns change, which CREATE OR
-- REPLACE can't do, so it is dropped and made again with the same security settings as in
-- 0005_api_keys.sql: SECURITY DEFINER, a fixed search_path, at most the one row whose hash matches,
-- callable by grc_app only (the api_keys_definer_read policy from 0005 stays as it is).
DROP FUNCTION app_api_key_by_hash(text);
--> statement-breakpoint
CREATE FUNCTION app_api_key_by_hash(h text)
  RETURNS TABLE (id uuid, org_id uuid, role text, clearance text, expires_at timestamptz, revoked_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog
  AS $$
  SELECT k.id, k.org_id, k.role, k.clearance, k.expires_at, k.revoked_at FROM public.api_keys k
  WHERE h IS NOT NULL AND k.key_hash = h
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_api_key_by_hash(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_api_key_by_hash(text) TO grc_app;
