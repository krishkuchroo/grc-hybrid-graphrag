-- FX-002 (D24, D263 item 2, Q-FX-1 (a)): a review finding may also be `superseded`. Runs as grc_migrator.
-- Only the repair command `pnpm dataset:reresolve` sets it, and only from `pending`: a stale pending
-- finding of an org loaded before FX-001 that the re-run matching no longer proposes. It is kept
-- (findings are never deleted, D24), it isn't a decision (`decided_by` and `decided_at` stay null),
-- and the review queue, its counts and the chat's "Not reviewed yet" list leave it out.
-- Only review_findings_status_check changes. Row security and grc_app's table rights (SELECT,
-- INSERT, UPDATE; no DELETE) are as they were. Existing rows are unchanged.
ALTER TABLE "review_findings" DROP CONSTRAINT "review_findings_status_check";
--> statement-breakpoint
ALTER TABLE "review_findings" ADD CONSTRAINT "review_findings_status_check" CHECK ("status" IN ('pending', 'live', 'approved', 'rejected', 'removed', 'superseded'));
