-- S4-002 (D13, D24, D38, D45.5, D50, D51, D57, D71, D73): the processing tables. Runs as
-- grc_migrator, which owns every table; grc_app gets row rights by name only
-- (src/processing/processing.schema.ts).
-- - chunks: each document's text in windows of at most 500 tokens, with its vector (vector(1024),
--   empty until embedded) and Gemma's stored extraction answer. List-partitioned by org, one
--   partition per org with its own HNSW cosine index (D71), made by chunks_create_partition.
-- - chunk_records: which records a chunk names, one row per chunk and record.
-- - review_findings: one row per AI proposal (link, record, duplicate, mapping); repeats add nothing
--   (a key unique per org); kept forever, so grc_app may not delete them (D24).
-- - documents.failure_code: why a document failed, empty otherwise.
-- Each is an org table with the org-wall policy (orgTablePolicySql, src/db/rls.sql.ts); SELECT also
-- checks the role and the label (D73: "Documents, chunks and findings also check role and label").

-- Why a document failed (S4-001's codes); empty unless its status is failed.
ALTER TABLE "documents" ADD COLUMN "failure_code" text;
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_failure_code_check" CHECK ("failure_code" IS NULL OR ("status" = 'failed' AND "failure_code" IN ('unreadable', 'no_text', 'timed_out', 'too_much_memory', 'read_failed', 'embed_failed', 'extract_failed', 'resolve_failed')));
--> statement-breakpoint

-- True when the context role's D50 "Review queue" cell is view or work; unknown values and no
-- role are false (built from ROLE_TABLE by role-visibility.sql.ts).
CREATE FUNCTION app_review_queue_visible() RETURNS boolean
  LANGUAGE sql STABLE
  SET search_path = pg_catalog
  AS $$
SELECT coalesce(
  nullif(current_setting('app.role', true), '') IN ('admin', 'analyst'),
  false
)
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_review_queue_visible() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_review_queue_visible() TO grc_app;
--> statement-breakpoint

-- Chunks (D71): one per document and position. The text is an exact slice of the document's text
-- (start and end offsets), and the record type and label are the document's (D51). The stage moves
-- read -> embedded -> (extracted ->) resolved, or failed. The document is in the same org: the
-- foreign key covers (org_id, document_id), because a foreign key check doesn't pass through RLS.
-- (org_id, id, record_type, label) is unique so chunk_records can carry the chunk's type and label
-- through a foreign key, and they can never differ from the chunk's.
CREATE TABLE "chunks" (
  "id" uuid NOT NULL DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "document_id" uuid NOT NULL,
  "position" integer NOT NULL,
  "text" text NOT NULL,
  "token_count" integer NOT NULL,
  "start_offset" integer NOT NULL,
  "end_offset" integer NOT NULL,
  "record_type" text NOT NULL,
  "label" text NOT NULL,
  "embedding" vector(1024),
  "stage" text NOT NULL DEFAULT 'read',
  "extraction" jsonb,
  "extraction_model" text,
  "extraction_prompt_version" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chunks_org_id_id_pk" PRIMARY KEY ("org_id", "id"),
  CONSTRAINT "chunks_org_document_position_unique" UNIQUE ("org_id", "document_id", "position"),
  CONSTRAINT "chunks_org_id_type_label_unique" UNIQUE ("org_id", "id", "record_type", "label"),
  CONSTRAINT "chunks_document_fk" FOREIGN KEY ("org_id", "document_id") REFERENCES "documents"("org_id", "id"),
  CONSTRAINT "chunks_position_check" CHECK ("position" >= 0),
  CONSTRAINT "chunks_text_check" CHECK (char_length("text") >= 1),
  CONSTRAINT "chunks_token_count_check" CHECK ("token_count" BETWEEN 1 AND 500),
  CONSTRAINT "chunks_offsets_check" CHECK ("start_offset" >= 0 AND "end_offset" > "start_offset"),
  CONSTRAINT "chunks_record_type_check" CHECK ("record_type" IN ('asset', 'policy', 'incident', 'audit_finding', 'evidence')),
  CONSTRAINT "chunks_label_check" CHECK ("label" IN ('public', 'internal', 'confidential', 'restricted')),
  CONSTRAINT "chunks_stage_check" CHECK ("stage" IN ('read', 'embedded', 'extracted', 'resolved', 'failed')),
  CONSTRAINT "chunks_embedded_check" CHECK ("stage" IN ('read', 'failed') OR "embedding" IS NOT NULL),
  CONSTRAINT "chunks_extracted_check" CHECK ("stage" <> 'extracted' OR "extraction" IS NOT NULL),
  CONSTRAINT "chunks_extraction_check" CHECK ("extraction" IS NULL OR (jsonb_typeof("extraction") = 'object' AND "extraction_model" IS NOT NULL AND "extraction_prompt_version" IS NOT NULL))
) PARTITION BY LIST ("org_id");
--> statement-breakpoint

-- Chunk to record (D71, D73): which records a chunk names. The chunk's record type and label come
-- with it through the foreign key (they follow the chunk if it changes, and go with it if it goes).
-- record_kind is the named record's type: one of the graph's record kinds.
CREATE TABLE "chunk_records" (
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "chunk_id" uuid NOT NULL,
  "record_id" uuid NOT NULL,
  "record_kind" text NOT NULL,
  "chunk_record_type" text NOT NULL,
  "label" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chunk_records_pk" PRIMARY KEY ("org_id", "chunk_id", "record_id"),
  CONSTRAINT "chunk_records_chunk_fk" FOREIGN KEY ("org_id", "chunk_id", "chunk_record_type", "label")
    REFERENCES "chunks"("org_id", "id", "record_type", "label") ON UPDATE CASCADE ON DELETE CASCADE,
  CONSTRAINT "chunk_records_record_kind_check" CHECK ("record_kind" IN ('asset', 'risk', 'control', 'policy', 'incident', 'evidence', 'audit_finding'))
);
--> statement-breakpoint
CREATE INDEX "chunk_records_org_record_idx" ON "chunk_records" ("org_id", "record_id");
--> statement-breakpoint

-- Review findings (D24, D38, D73): one row per proposal. link and record findings come from a
-- document (link findings from one chunk and sentence of it); duplicate and mapping findings have
-- no source. Only S5 sets approved, rejected and removed, with who, when and a note. The key makes
-- a repeat proposal add nothing. The document and the chunk are in the same org (foreign keys over
-- org_id); a chunk a finding came from can't be deleted, so every finding stays traceable (D52.5).
CREATE TABLE "review_findings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "kind" text NOT NULL,
  "status" text NOT NULL DEFAULT 'pending',
  "finding_key" text NOT NULL,
  "proposal" jsonb NOT NULL,
  "document_id" uuid,
  "chunk_id" uuid,
  "sentence" text,
  "failed_checks" text[] NOT NULL DEFAULT '{}'::text[],
  "label" text NOT NULL,
  "model" text,
  "prompt_version" text,
  "decided_by" text,
  "decided_at" timestamptz,
  "decision_note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "review_findings_org_key_unique" UNIQUE ("org_id", "finding_key"),
  CONSTRAINT "review_findings_org_id_id_unique" UNIQUE ("org_id", "id"),
  CONSTRAINT "review_findings_document_fk" FOREIGN KEY ("org_id", "document_id") REFERENCES "documents"("org_id", "id"),
  CONSTRAINT "review_findings_chunk_fk" FOREIGN KEY ("org_id", "chunk_id") REFERENCES "chunks"("org_id", "id"),
  CONSTRAINT "review_findings_kind_check" CHECK ("kind" IN ('link', 'record', 'duplicate', 'mapping')),
  CONSTRAINT "review_findings_status_check" CHECK ("status" IN ('pending', 'live', 'approved', 'rejected', 'removed')),
  CONSTRAINT "review_findings_key_check" CHECK (char_length("finding_key") BETWEEN 1 AND 512),
  CONSTRAINT "review_findings_proposal_check" CHECK (jsonb_typeof("proposal") = 'object'),
  CONSTRAINT "review_findings_failed_checks_check" CHECK ("failed_checks" <@ ARRAY['same_sentence', 'ontology_fit', 'both_ends_known']::text[]),
  CONSTRAINT "review_findings_label_check" CHECK ("label" IN ('public', 'internal', 'confidential', 'restricted')),
  CONSTRAINT "review_findings_source_check" CHECK (
    ("kind" = 'link' AND "document_id" IS NOT NULL AND "chunk_id" IS NOT NULL AND "sentence" IS NOT NULL)
    OR ("kind" = 'record' AND "document_id" IS NOT NULL)
    OR ("kind" IN ('duplicate', 'mapping') AND "document_id" IS NULL AND "chunk_id" IS NULL AND "sentence" IS NULL)
  ),
  CONSTRAINT "review_findings_model_check" CHECK ("kind" = 'duplicate' OR ("model" IS NOT NULL AND "prompt_version" IS NOT NULL)),
  CONSTRAINT "review_findings_decision_check" CHECK (("decided_by" IS NULL) = ("decided_at" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "review_findings_org_status_created_idx" ON "review_findings" ("org_id", "status", "created_at");
--> statement-breakpoint
CREATE INDEX "review_findings_org_document_idx" ON "review_findings" ("org_id", "document_id");
--> statement-breakpoint
CREATE INDEX "review_findings_org_chunk_idx" ON "review_findings" ("org_id", "chunk_id");
--> statement-breakpoint

-- One chunk partition per org, called by org provisioning (src/identity/provision-org.ts) through
-- createChunkPartition, and below for every org that already exists. Safe to call again: each step
-- is "if missing". The partition gets its own HNSW cosine index on the vector (D71), and RLS
-- enabled and forced with no policy and no grant, so grc_app reaches its rows only through the
-- chunks table, whose policies apply.
CREATE FUNCTION chunks_create_partition(org uuid) RETURNS void
  LANGUAGE plpgsql
  SET search_path = pg_catalog
  AS $$
DECLARE
  part text := 'chunks_' || replace(org::text, '-', '');
  rel regclass;
BEGIN
  IF org IS NULL THEN
    RAISE EXCEPTION 'chunks_create_partition: org is null';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('chunks_create_partition'));
  rel := to_regclass(format('public.%I', part));
  IF rel IS NULL THEN
    EXECUTE format('CREATE TABLE public.%I PARTITION OF public.chunks FOR VALUES IN (%L)', part, org);
    rel := to_regclass(format('public.%I', part));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = rel AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', part);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', part);
  END IF;
  EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON public.%I USING hnsw (embedding public.vector_cosine_ops)',
                 part || '_embedding_hnsw', part);
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION chunks_create_partition(uuid) FROM PUBLIC;
--> statement-breakpoint

-- A partition for every org that already exists. grc_migrator can't read the organization table
-- (FORCE RLS, no policy for it), so the orgs come from the catalog: provisioning makes each org's
-- audit partition first (audit_create_partition), and its bound holds the org's ID.
DO $$
DECLARE
  org uuid;
BEGIN
  FOR org IN
    SELECT DISTINCT (regexp_match(pg_get_expr(c.relpartbound, c.oid),
                     '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'))[1]::uuid
    FROM pg_catalog.pg_inherits i
    JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
    WHERE i.inhparent = 'public.audit_events'::regclass
  LOOP
    IF org IS NOT NULL THEN
      PERFORM public.chunks_create_partition(org);
    END IF;
  END LOOP;
END
$$;
--> statement-breakpoint

-- The org wall (orgTablePolicySql). chunks: SELECT also needs the role to view the chunk's record
-- type and the label to be at or below the clearance (D73). chunk_records: the same checks on the
-- chunk's record type and label, and the role views the named record's kind. review_findings:
-- SELECT also needs the role's "Review queue" cell (Admin, Analyst) and the label check; inserts
-- and updates only in the caller's own org, and no DELETE at all (findings are kept, D24).
ALTER TABLE "chunks" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "chunks" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "chunks_org_select" ON "chunks" FOR SELECT TO grc_app USING (app_visible_org("org_id") AND app_role_views("record_type") AND app_label_visible("label"));
--> statement-breakpoint
CREATE POLICY "chunks_org_insert" ON "chunks" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "chunks_org_update" ON "chunks" FOR UPDATE TO grc_app USING ("org_id" = app_org_id()) WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "chunks_org_delete" ON "chunks" FOR DELETE TO grc_app USING ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "chunks" TO grc_app;
--> statement-breakpoint
ALTER TABLE "chunk_records" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "chunk_records" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "chunk_records_org_select" ON "chunk_records" FOR SELECT TO grc_app USING (app_visible_org("org_id") AND app_role_views("chunk_record_type") AND app_label_visible("label") AND app_role_views("record_kind"));
--> statement-breakpoint
CREATE POLICY "chunk_records_org_insert" ON "chunk_records" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "chunk_records_org_update" ON "chunk_records" FOR UPDATE TO grc_app USING ("org_id" = app_org_id()) WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "chunk_records_org_delete" ON "chunk_records" FOR DELETE TO grc_app USING ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON "chunk_records" TO grc_app;
--> statement-breakpoint
ALTER TABLE "review_findings" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "review_findings" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "review_findings_org_select" ON "review_findings" FOR SELECT TO grc_app USING (app_visible_org("org_id") AND app_review_queue_visible() AND app_label_visible("label"));
--> statement-breakpoint
CREATE POLICY "review_findings_org_insert" ON "review_findings" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
CREATE POLICY "review_findings_org_update" ON "review_findings" FOR UPDATE TO grc_app USING ("org_id" = app_org_id()) WITH CHECK ("org_id" = app_org_id());
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "review_findings" TO grc_app;
