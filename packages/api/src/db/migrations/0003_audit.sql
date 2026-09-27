-- M0-012 (D37, D56, D72, D73): the audit trail. Add-only events, one hash chain per org, the
-- table partitioned by org. Runs as grc_migrator, which owns the table.
-- grc_app may SELECT and INSERT under the org wall, and nothing else. A trigger refuses UPDATE,
-- DELETE and TRUNCATE at runtime, including by the owner.
CREATE TABLE "audit_events" (
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "seq" bigint NOT NULL,
  "prev_hash" text NOT NULL,
  "hash" text NOT NULL,
  "actor_type" text NOT NULL,
  "actor_id" text NOT NULL,
  "action" text NOT NULL,
  "target_type" text,
  "target_id" text,
  "before" jsonb,
  "after" jsonb,
  "meta" jsonb,
  "source_id" text,
  "created_at" timestamptz NOT NULL,
  CONSTRAINT "audit_events_org_id_seq_pk" PRIMARY KEY ("org_id", "seq"),
  CONSTRAINT "audit_events_org_source_id" UNIQUE ("org_id", "source_id"),
  CONSTRAINT "audit_events_actor_type_check" CHECK ("actor_type" IN ('user', 'api_key', 'system'))
) PARTITION BY LIST ("org_id");
--> statement-breakpoint

-- Add-only: refuses every change to a stored event, whoever runs it.
CREATE FUNCTION audit_events_refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
BEGIN
  RAISE EXCEPTION 'audit events are add-only: % is refused', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_events_refuse_change() FROM PUBLIC;
--> statement-breakpoint
-- Row triggers on a partitioned table are cloned onto every partition.
CREATE TRIGGER "audit_events_no_update_delete" BEFORE UPDATE OR DELETE ON "audit_events"
  FOR EACH ROW EXECUTE FUNCTION audit_events_refuse_change();
--> statement-breakpoint
-- Statement triggers are not cloned: audit_create_partition adds one to each partition.
CREATE TRIGGER "audit_events_no_truncate" BEFORE TRUNCATE ON "audit_events"
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_refuse_change();
--> statement-breakpoint

-- The org wall (orgTablePolicySql), with only SELECT and INSERT for grc_app.
ALTER TABLE "audit_events" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "audit_events_org_select" ON "audit_events" FOR SELECT TO grc_app USING (app_visible_org("org_id"));
--> statement-breakpoint
CREATE POLICY "audit_events_org_insert" ON "audit_events" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON "audit_events" TO grc_app;
--> statement-breakpoint

-- One partition per org, called by org provisioning (M0-014) through createAuditPartition.
-- Safe to call again. The partition gets the same RLS, forced, and its own TRUNCATE trigger.
-- grc_app gets no rights on the partition itself, so it reaches rows only through the table.
CREATE FUNCTION audit_create_partition(org uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  part text := 'audit_events_' || replace(org::text, '-', '');
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'audit_create_partition: org is null';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('audit_create_partition'));
  IF to_regclass(format('public.%I', part)) IS NOT NULL THEN
    RETURN;
  END IF;
  EXECUTE format('CREATE TABLE public.%I PARTITION OF public.audit_events FOR VALUES IN (%L)', part, org);
  EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', part);
  EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', part);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR SELECT TO grc_app USING (public.app_visible_org(org_id))',
                 part || '_org_select', part);
  EXECUTE format('CREATE POLICY %I ON public.%I FOR INSERT TO grc_app WITH CHECK (org_id = public.app_org_id())',
                 part || '_org_insert', part);
  EXECUTE format('CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON public.%I '
                 'FOR EACH STATEMENT EXECUTE FUNCTION public.audit_events_refuse_change()', part);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION audit_create_partition(uuid) FROM PUBLIC;
