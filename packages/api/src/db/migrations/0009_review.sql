-- S5-001 (D24, D38, D52.5, D69, D73): the Analyst review's groundwork. Runs as grc_migrator.
-- - review_findings.outcome: what an Analyst's decision made or removed, by record ID and number
--   (S5-001's outcome shapes in @grc/shared): empty until a decision, and an object when set.
-- - documents.status may also be removed: a whole upload taken back out (D52.5). It stays stored.
-- Nothing else in either table or its row security changes; grc_app keeps its table rights, so it
-- may set the new column, and still has no DELETE on review_findings (findings are kept, D24).
-- Existing rows are unchanged: their outcome is empty and their status is one of the old ones.
ALTER TABLE "review_findings" ADD COLUMN "outcome" jsonb;
--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_outcome_check" CHECK ("outcome" IS NULL OR (jsonb_typeof("outcome") = 'object' AND "decided_at" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "documents" DROP CONSTRAINT "documents_status_check";
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_status_check" CHECK ("status" IN ('stored', 'processing', 'processed', 'failed', 'removed'));
