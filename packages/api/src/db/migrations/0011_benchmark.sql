-- S8-001 (D1, D45.8, D50, D51, D56, D57, D73): the benchmark tables. Runs as grc_migrator, which owns
-- both tables; grc_app gets row rights by name only (src/search/benchmark/benchmark.schema.ts).
-- - benchmark_runs: one per benchmark run, in the org it ran against (S8-Q1). Who started it (the
--   principal user ID: a person's user ID, or `api_key:<id>` for a machine key), its status, parts
--   and modes, its settings (the start body plus the models, prompt versions, limits, cut-offs and
--   injection checks the API ran with, D45.8), its summary (empty until it ends), a failed run's
--   code, its label (the starter's clearance, D51), and when it started, ended and last moved on.
--   Only its status, summary, failure code, finished time and last-activity time may change.
-- - benchmark_results: one per result item (S8-001's item shape in @grc/shared): its run, item key,
--   part, mode, kind, outcome, metric values and details, and when it was stored. Unique on run +
--   item key + part + mode (a question's retrieval and answers items share its key and mode), so a
--   repeated item adds nothing. Results are never changed. `id` counts up in
--   the order results are stored, so they can be read back in the order they were sent.
-- Row security is forced on both, for the restricted app account (D57): the org wall, and every
-- read, insert and update only where the row's org is the context org (`app.org_id`, never another
-- org seen through a grant or a parent link) and the context role (`app.role`) is admin, the role
-- table's `admin` cell (D50). A result can only be added to a run of the same org: its foreign key
-- covers (org_id, run_id), and a foreign key check doesn't pass through RLS, so the run must be the
-- same org's. Nothing may be deleted: grc_app has no DELETE on either table. No existing table
-- changes.

CREATE TABLE "benchmark_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "started_by" text NOT NULL,
  "status" text NOT NULL DEFAULT 'running',
  "parts" text[] NOT NULL,
  "modes" text[] NOT NULL,
  "settings" jsonb NOT NULL,
  "summary" jsonb,
  "failure_code" text,
  "label" text NOT NULL,
  "started_at" timestamptz NOT NULL DEFAULT now(),
  "finished_at" timestamptz,
  "last_activity_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "benchmark_runs_org_id_id_unique" UNIQUE ("org_id", "id"),
  CONSTRAINT "benchmark_runs_started_by_check" CHECK (char_length("started_by") BETWEEN 1 AND 200),
  CONSTRAINT "benchmark_runs_status_check" CHECK ("status" IN ('running', 'finished', 'failed')),
  CONSTRAINT "benchmark_runs_parts_check" CHECK (cardinality("parts") BETWEEN 1 AND 3 AND array_position("parts", NULL) IS NULL AND "parts" <@ ARRAY['retrieval', 'answers', 'extraction']::text[]),
  CONSTRAINT "benchmark_runs_modes_check" CHECK (cardinality("modes") BETWEEN 1 AND 3 AND array_position("modes", NULL) IS NULL AND "modes" <@ ARRAY['hybrid', 'vector', 'pipeline']::text[]),
  CONSTRAINT "benchmark_runs_settings_check" CHECK (jsonb_typeof("settings") = 'object'),
  CONSTRAINT "benchmark_runs_summary_check" CHECK ("summary" IS NULL OR (jsonb_typeof("summary") = 'object' AND "status" <> 'running')),
  CONSTRAINT "benchmark_runs_failure_code_check" CHECK (("failure_code" IS NULL) = ("status" <> 'failed') AND ("failure_code" IS NULL OR (char_length("failure_code") BETWEEN 1 AND 64 AND "failure_code" ~ '^[a-z][a-z0-9_]*$'))),
  CONSTRAINT "benchmark_runs_finished_at_check" CHECK (("finished_at" IS NULL) = ("status" = 'running')),
  CONSTRAINT "benchmark_runs_label_check" CHECK ("label" IN ('public', 'internal', 'confidential', 'restricted'))
);
--> statement-breakpoint
CREATE INDEX "benchmark_runs_org_started_idx" ON "benchmark_runs" ("org_id", "started_at", "id");
--> statement-breakpoint
CREATE INDEX "benchmark_runs_org_status_started_idx" ON "benchmark_runs" ("org_id", "status", "started_at");
--> statement-breakpoint

CREATE TABLE "benchmark_results" (
  "id" bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "run_id" uuid NOT NULL,
  "item_key" text NOT NULL,
  "part" text NOT NULL,
  "mode" text NOT NULL,
  "kind" text NOT NULL,
  "outcome" text NOT NULL,
  "metrics" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "details" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "benchmark_results_run_fk" FOREIGN KEY ("org_id", "run_id") REFERENCES "benchmark_runs"("org_id", "id"),
  CONSTRAINT "benchmark_results_run_item_part_mode_unique" UNIQUE ("run_id", "item_key", "part", "mode"),
  CONSTRAINT "benchmark_results_item_key_check" CHECK (char_length("item_key") BETWEEN 1 AND 200 AND "item_key" ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]*$'),
  CONSTRAINT "benchmark_results_part_mode_check" CHECK (("part" IN ('retrieval', 'answers') AND "mode" IN ('hybrid', 'vector')) OR ("part" = 'extraction' AND "mode" = 'pipeline')),
  CONSTRAINT "benchmark_results_kind_check" CHECK (("part" IN ('retrieval', 'answers') AND "kind" IN ('single_hop', 'multi_hop', 'framework', 'no_answer', 'injection_trap')) OR ("part" = 'extraction' AND "kind" IN ('stated_fact', 'extra_ai_link', 'false_positive_plant', 'injection_plant', 'analyst_decision'))),
  CONSTRAINT "benchmark_results_outcome_check" CHECK ("outcome" IN ('pass', 'partial', 'fail', 'skipped')),
  CONSTRAINT "benchmark_results_metrics_check" CHECK (jsonb_typeof("metrics") = 'object'),
  CONSTRAINT "benchmark_results_details_check" CHECK (jsonb_typeof("details") = 'object')
);
--> statement-breakpoint
CREATE INDEX "benchmark_results_org_run_idx" ON "benchmark_results" ("org_id", "run_id", "id");
--> statement-breakpoint

-- The org wall and the admin role, on every read, insert and update (no DELETE policy and no
-- DELETE right: nothing is deleted). grc_app may change only a run's status, summary, failure code,
-- finished time and last-activity time, and never a result.
ALTER TABLE "benchmark_runs" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "benchmark_runs" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "benchmark_runs_admin_select" ON "benchmark_runs" FOR SELECT TO grc_app USING ("org_id" = app_org_id() AND nullif(current_setting('app.role', true), '') = 'admin');
--> statement-breakpoint
CREATE POLICY "benchmark_runs_admin_insert" ON "benchmark_runs" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id() AND nullif(current_setting('app.role', true), '') = 'admin');
--> statement-breakpoint
CREATE POLICY "benchmark_runs_admin_update" ON "benchmark_runs" FOR UPDATE TO grc_app USING ("org_id" = app_org_id() AND nullif(current_setting('app.role', true), '') = 'admin') WITH CHECK ("org_id" = app_org_id() AND nullif(current_setting('app.role', true), '') = 'admin');
--> statement-breakpoint
GRANT SELECT, INSERT ON "benchmark_runs" TO grc_app;
--> statement-breakpoint
GRANT UPDATE ("status", "summary", "failure_code", "finished_at", "last_activity_at") ON "benchmark_runs" TO grc_app;
--> statement-breakpoint
ALTER TABLE "benchmark_results" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "benchmark_results" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "benchmark_results_admin_select" ON "benchmark_results" FOR SELECT TO grc_app USING ("org_id" = app_org_id() AND nullif(current_setting('app.role', true), '') = 'admin');
--> statement-breakpoint
CREATE POLICY "benchmark_results_admin_insert" ON "benchmark_results" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id() AND nullif(current_setting('app.role', true), '') = 'admin');
--> statement-breakpoint
GRANT SELECT, INSERT ON "benchmark_results" TO grc_app;
