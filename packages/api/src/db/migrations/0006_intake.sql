-- S3-003 (D13, D29, D45.5, D51, D57, D72, D73): the intake tables. Runs as grc_migrator, which
-- owns every table; grc_app gets row rights by name only (src/intake/intake.schema.ts).
-- - documents: every stored file, identified by its content (one content hash per org).
-- - import_mappings: the saved column mapping per source.
-- - imports: one asset-list import of a document.
-- - push_batches: the push API's batches; a repeat (same source and batch ID) gets the first answer.
-- Each is an org table with the standard org-wall policy (orgTablePolicySql, src/db/rls.sql.ts). On
-- documents and imports the SELECT policy also checks the role and the label (D73), through the two
-- functions below, pasted from roleVisibilitySql() (src/db/role-visibility.sql.ts).

-- True when the context role's D50 cell for the record type is view, edit or approve; ownership
-- cells, unknown values and no role are false (built from ROLE_TABLE by role-visibility.sql.ts).
CREATE FUNCTION app_role_views(record_type text) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
  AS $$
SELECT coalesce(
  (nullif(current_setting('app.role', true), ''), $1) IN (
    ('admin', 'asset'),
    ('admin', 'risk'),
    ('admin', 'control'),
    ('admin', 'policy'),
    ('admin', 'incident'),
    ('admin', 'framework_mapping'),
    ('admin', 'evidence'),
    ('admin', 'audit_finding'),
    ('risk_manager', 'asset'),
    ('risk_manager', 'risk'),
    ('risk_manager', 'control'),
    ('risk_manager', 'policy'),
    ('risk_manager', 'incident'),
    ('risk_manager', 'framework_mapping'),
    ('risk_manager', 'evidence'),
    ('risk_manager', 'audit_finding'),
    ('compliance_manager', 'asset'),
    ('compliance_manager', 'risk'),
    ('compliance_manager', 'control'),
    ('compliance_manager', 'policy'),
    ('compliance_manager', 'incident'),
    ('compliance_manager', 'framework_mapping'),
    ('compliance_manager', 'evidence'),
    ('compliance_manager', 'audit_finding'),
    ('control_owner', 'asset'),
    ('control_owner', 'risk'),
    ('control_owner', 'policy'),
    ('control_owner', 'framework_mapping'),
    ('control_owner', 'audit_finding'),
    ('auditor', 'asset'),
    ('auditor', 'risk'),
    ('auditor', 'control'),
    ('auditor', 'policy'),
    ('auditor', 'incident'),
    ('auditor', 'framework_mapping'),
    ('auditor', 'evidence'),
    ('auditor', 'audit_finding'),
    ('analyst', 'asset'),
    ('analyst', 'risk'),
    ('analyst', 'control'),
    ('analyst', 'policy'),
    ('analyst', 'incident'),
    ('analyst', 'framework_mapping'),
    ('analyst', 'evidence'),
    ('analyst', 'audit_finding'),
    ('viewer', 'asset'),
    ('viewer', 'risk'),
    ('viewer', 'control'),
    ('viewer', 'policy'),
    ('viewer', 'framework_mapping')
  ),
  false
)
$$;
--> statement-breakpoint
-- True when the label ranks at or below the context clearance; unknown values and no clearance
-- are false (built from LABELS by role-visibility.sql.ts).
CREATE FUNCTION app_label_visible(label text) RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
  AS $$
SELECT coalesce(
  (CASE $1 WHEN 'public' THEN 0 WHEN 'internal' THEN 1 WHEN 'confidential' THEN 2 WHEN 'restricted' THEN 3 END)
    <= (CASE nullif(current_setting('app.clearance', true), '') WHEN 'public' THEN 0 WHEN 'internal' THEN 1 WHEN 'confidential' THEN 2 WHEN 'restricted' THEN 3 END),
  false
)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_role_views(text) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_label_visible(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_role_views(text) TO grc_app;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_label_visible(text) TO grc_app;
--> statement-breakpoint

-- Documents (D45.5, D71, D73): the kind's record type, the label, the uploader and the status.
CREATE TABLE "documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "kind" text NOT NULL,
  "record_type" text NOT NULL,
  "format" text NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "size_bytes" integer NOT NULL,
  "content_hash" text NOT NULL,
  "storage_key" text NOT NULL,
  "label" text NOT NULL,
  "uploader_type" text NOT NULL,
  "uploader_id" text NOT NULL,
  "source" text,
  "status" text NOT NULL DEFAULT 'stored',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "documents_org_content_hash_unique" UNIQUE ("org_id", "content_hash"),
  CONSTRAINT "documents_org_id_id_unique" UNIQUE ("org_id", "id"),
  CONSTRAINT "documents_kind_check" CHECK ("kind" IN ('asset_list', 'policy_document', 'soc_ticket', 'audit_report', 'evidence')),
  CONSTRAINT "documents_record_type_check" CHECK ("record_type" IN ('asset', 'policy', 'incident', 'audit_finding', 'evidence')),
  CONSTRAINT "documents_kind_record_type_check" CHECK (("kind", "record_type") IN (('asset_list', 'asset'), ('policy_document', 'policy'), ('soc_ticket', 'incident'), ('audit_report', 'audit_finding'), ('evidence', 'evidence'))),
  CONSTRAINT "documents_format_check" CHECK ("format" IN ('pdf', 'docx', 'csv', 'json', 'txt')),
  CONSTRAINT "documents_label_check" CHECK ("label" IN ('public', 'internal', 'confidential', 'restricted')),
  CONSTRAINT "documents_uploader_type_check" CHECK ("uploader_type" IN ('user', 'api_key', 'system')),
  CONSTRAINT "documents_status_check" CHECK ("status" IN ('stored', 'processing', 'processed', 'failed')),
  CONSTRAINT "documents_content_hash_check" CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  CONSTRAINT "documents_file_name_check" CHECK (char_length("file_name") BETWEEN 1 AND 255),
  CONSTRAINT "documents_size_bytes_check" CHECK ("size_bytes" > 0 AND "size_bytes" <= 26214400),
  CONSTRAINT "documents_source_check" CHECK (("kind" = 'asset_list' AND "source" IS NOT NULL) OR ("kind" <> 'asset_list' AND "source" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "documents_org_created_idx" ON "documents" ("org_id", "created_at");
--> statement-breakpoint

-- Import mappings (D40, D44): one saved column mapping per source and org.
CREATE TABLE "import_mappings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "source" text NOT NULL,
  "fields" jsonb NOT NULL,
  "version" integer NOT NULL DEFAULT 1,
  "created_by" text NOT NULL,
  "updated_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "import_mappings_org_source_unique" UNIQUE ("org_id", "source"),
  CONSTRAINT "import_mappings_version_check" CHECK ("version" >= 1),
  CONSTRAINT "import_mappings_fields_check" CHECK (jsonb_typeof("fields") = 'object')
);
--> statement-breakpoint

-- Imports (D40, D44): one asset-list import of a document, with the document's label.
-- The document is in the same org: the foreign key covers (org_id, document_id), because a
-- foreign key check doesn't pass through RLS.
CREATE TABLE "imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "document_id" uuid NOT NULL,
  "source" text NOT NULL,
  "status" text NOT NULL DEFAULT 'reading',
  "label" text NOT NULL,
  "record_type" text NOT NULL DEFAULT 'asset',
  "columns" jsonb,
  "sample" jsonb,
  "row_count" integer,
  "mapping" jsonb,
  "counts" jsonb,
  "errors" jsonb,
  "job_id" uuid,
  "created_by" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "imports_document_fk" FOREIGN KEY ("org_id", "document_id") REFERENCES "documents"("org_id", "id"),
  CONSTRAINT "imports_org_id_id_unique" UNIQUE ("org_id", "id"),
  CONSTRAINT "imports_status_check" CHECK ("status" IN ('reading', 'needs_mapping', 'queued', 'importing', 'done', 'failed')),
  CONSTRAINT "imports_label_check" CHECK ("label" IN ('public', 'internal', 'confidential', 'restricted')),
  CONSTRAINT "imports_record_type_check" CHECK ("record_type" IN ('asset')),
  CONSTRAINT "imports_row_count_check" CHECK ("row_count" IS NULL OR "row_count" >= 0),
  CONSTRAINT "imports_columns_check" CHECK ("columns" IS NULL OR jsonb_typeof("columns") = 'array'),
  CONSTRAINT "imports_sample_check" CHECK ("sample" IS NULL OR (jsonb_typeof("sample") = 'array' AND jsonb_array_length("sample") <= 5)),
  CONSTRAINT "imports_errors_check" CHECK ("errors" IS NULL OR (jsonb_typeof("errors") = 'array' AND jsonb_array_length("errors") <= 200)),
  CONSTRAINT "imports_mapping_check" CHECK ("mapping" IS NULL OR jsonb_typeof("mapping") = 'object'),
  CONSTRAINT "imports_counts_check" CHECK ("counts" IS NULL OR jsonb_typeof("counts") = 'object')
);
--> statement-breakpoint
CREATE INDEX "imports_org_created_idx" ON "imports" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX "imports_org_document_idx" ON "imports" ("org_id", "document_id");
--> statement-breakpoint

-- Push batches (D47): remembered per source and batch ID, so a repeat gets the first answer.
-- The document and the import are in the same org (foreign keys over org_id, as on imports).
CREATE TABLE "push_batches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "api_key_id" uuid NOT NULL REFERENCES "api_keys"("id"),
  "source" text NOT NULL,
  "batch_id" text NOT NULL,
  "document_id" uuid,
  "import_id" uuid,
  "row_count" integer NOT NULL,
  "answer" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "push_batches_org_source_batch_unique" UNIQUE ("org_id", "source", "batch_id"),
  CONSTRAINT "push_batches_document_fk" FOREIGN KEY ("org_id", "document_id") REFERENCES "documents"("org_id", "id"),
  CONSTRAINT "push_batches_import_fk" FOREIGN KEY ("org_id", "import_id") REFERENCES "imports"("org_id", "id"),
  CONSTRAINT "push_batches_row_count_check" CHECK ("row_count" >= 0)
);
--> statement-breakpoint
CREATE INDEX "push_batches_org_created_idx" ON "push_batches" ("org_id", "created_at");
--> statement-breakpoint
CREATE INDEX "push_batches_org_import_idx" ON "push_batches" ("org_id", "import_id");
--> statement-breakpoint

-- The org wall (orgTablePolicySql). documents and imports: SELECT also needs the role to view the
-- row's record type and the label to be at or below the clearance (D73). The no-owner rule for
-- evidence is deliberate: evidence rows are read under the intake system context (planner's
-- reading R12).
ALTER TABLE "documents" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "documents" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "documents_org_select" ON "documents" FOR SELECT TO grc_app USING (app_visible_org("org_id") AND app_role_views("record_type") AND app_label_visible("label"));
--> statement-breakpoint
CREATE POLICY "documents_org_insert" ON "documents" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "documents_org_update" ON "documents" FOR UPDATE TO grc_app USING ("org_id" = app_org_id()) WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "documents_org_delete" ON "documents" FOR DELETE TO grc_app USING ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "documents" TO grc_app;
--> statement-breakpoint
ALTER TABLE "imports" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "imports" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "imports_org_select" ON "imports" FOR SELECT TO grc_app USING (app_visible_org("org_id") AND app_role_views("record_type") AND app_label_visible("label"));
--> statement-breakpoint
CREATE POLICY "imports_org_insert" ON "imports" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "imports_org_update" ON "imports" FOR UPDATE TO grc_app USING ("org_id" = app_org_id()) WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "imports_org_delete" ON "imports" FOR DELETE TO grc_app USING ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "imports" TO grc_app;
--> statement-breakpoint
ALTER TABLE "import_mappings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "import_mappings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "import_mappings_org_select" ON "import_mappings" FOR SELECT TO grc_app USING (app_visible_org("org_id"));
--> statement-breakpoint
CREATE POLICY "import_mappings_org_insert" ON "import_mappings" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "import_mappings_org_update" ON "import_mappings" FOR UPDATE TO grc_app USING ("org_id" = app_org_id()) WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "import_mappings_org_delete" ON "import_mappings" FOR DELETE TO grc_app USING ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "import_mappings" TO grc_app;
--> statement-breakpoint
ALTER TABLE "push_batches" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "push_batches" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "push_batches_org_select" ON "push_batches" FOR SELECT TO grc_app USING (app_visible_org("org_id"));
--> statement-breakpoint
CREATE POLICY "push_batches_org_insert" ON "push_batches" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "push_batches_org_update" ON "push_batches" FOR UPDATE TO grc_app USING ("org_id" = app_org_id()) WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "push_batches_org_delete" ON "push_batches" FOR DELETE TO grc_app USING ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "push_batches" TO grc_app;
