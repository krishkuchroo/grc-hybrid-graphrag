-- S6-001 (D47, D51, D56, D57, D73): the chat tables. Runs as grc_migrator, which owns both tables;
-- grc_app gets row rights by name only (src/chat/chat.schema.ts).
-- - chat_conversations: one per conversation, owned by the asker's principal user ID (`app.user_id`:
--   a person's user ID, or `api_key:<id>` for a machine key). Its title and updated time may change.
-- - chat_messages: one per question, with its answer, status, mode, fallback reason, citations,
--   graph query, model, prompt versions, timings and label (S6-001's message shapes in @grc/shared).
--   Messages are never changed.
-- Row security is forced on both, for the restricted app account (D57): the org wall, and every
-- read, insert and update only where the row's org is the context org (`app.org_id`, never another
-- org seen through a grant) and its owner is the asker (`app.user_id`). A message can only go into
-- the asker's own conversation: its foreign key covers (org_id, owner_id, conversation_id), and a
-- foreign key check doesn't pass through RLS, so the conversation must be the same org's and the
-- same owner's. Nothing may be deleted: grc_app has no DELETE on either table. No existing table
-- changes.

CREATE TABLE "chat_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "owner_id" text NOT NULL,
  "title" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chat_conversations_org_owner_id_unique" UNIQUE ("org_id", "owner_id", "id"),
  CONSTRAINT "chat_conversations_owner_check" CHECK (char_length("owner_id") BETWEEN 1 AND 200),
  CONSTRAINT "chat_conversations_title_check" CHECK (char_length("title") BETWEEN 1 AND 80)
);
--> statement-breakpoint
CREATE INDEX "chat_conversations_org_owner_updated_idx" ON "chat_conversations" ("org_id", "owner_id", "updated_at", "id");
--> statement-breakpoint

CREATE TABLE "chat_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL REFERENCES "organization"("id"),
  "conversation_id" uuid NOT NULL,
  "owner_id" text NOT NULL,
  "question" text NOT NULL,
  "answer" text NOT NULL DEFAULT '',
  "status" text NOT NULL,
  "mode" text NOT NULL,
  "fallback_reason" text,
  "citations" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "graph_query" text,
  "model" text,
  "prompt_versions" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "timings" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "label" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "chat_messages_conversation_fk" FOREIGN KEY ("org_id", "owner_id", "conversation_id")
    REFERENCES "chat_conversations"("org_id", "owner_id", "id"),
  CONSTRAINT "chat_messages_question_check" CHECK (char_length("question") BETWEEN 1 AND 2000),
  CONSTRAINT "chat_messages_status_check" CHECK ("status" IN ('answered', 'stopped', 'failed')),
  CONSTRAINT "chat_messages_mode_check" CHECK ("mode" IN ('hybrid', 'vector')),
  CONSTRAINT "chat_messages_fallback_reason_check" CHECK ("fallback_reason" IS NULL OR ("mode" = 'hybrid' AND "fallback_reason" IN ('graph_model_unavailable', 'graph_query_invalid', 'graph_query_refused', 'graph_query_timed_out', 'graph_query_failed'))),
  CONSTRAINT "chat_messages_citations_check" CHECK (jsonb_typeof("citations") = 'array'),
  CONSTRAINT "chat_messages_graph_query_check" CHECK ("graph_query" IS NULL OR ("mode" = 'hybrid' AND char_length("graph_query") BETWEEN 1 AND 2000)),
  CONSTRAINT "chat_messages_prompt_versions_check" CHECK (jsonb_typeof("prompt_versions") = 'object'),
  CONSTRAINT "chat_messages_timings_check" CHECK (jsonb_typeof("timings") = 'object'),
  CONSTRAINT "chat_messages_label_check" CHECK ("label" IN ('public', 'internal', 'confidential', 'restricted'))
);
--> statement-breakpoint
CREATE INDEX "chat_messages_org_conversation_created_idx" ON "chat_messages" ("org_id", "conversation_id", "created_at", "id");
--> statement-breakpoint

-- The org wall and the owner, on every read, insert and update (no DELETE policy and no DELETE
-- right: nothing is deleted). grc_app may change only a conversation's title and updated time.
ALTER TABLE "chat_conversations" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "chat_conversations" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "chat_conversations_owner_select" ON "chat_conversations" FOR SELECT TO grc_app USING ("org_id" = app_org_id() AND "owner_id" = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
CREATE POLICY "chat_conversations_owner_insert" ON "chat_conversations" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id() AND "owner_id" = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
CREATE POLICY "chat_conversations_owner_update" ON "chat_conversations" FOR UPDATE TO grc_app USING ("org_id" = app_org_id() AND "owner_id" = nullif(current_setting('app.user_id', true), '')) WITH CHECK ("org_id" = app_org_id() AND "owner_id" = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT ON "chat_conversations" TO grc_app;
--> statement-breakpoint
GRANT UPDATE ("title", "updated_at") ON "chat_conversations" TO grc_app;
--> statement-breakpoint
ALTER TABLE "chat_messages" ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
ALTER TABLE "chat_messages" FORCE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY "chat_messages_owner_select" ON "chat_messages" FOR SELECT TO grc_app USING ("org_id" = app_org_id() AND "owner_id" = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
CREATE POLICY "chat_messages_owner_insert" ON "chat_messages" FOR INSERT TO grc_app WITH CHECK ("org_id" = app_org_id() AND "owner_id" = nullif(current_setting('app.user_id', true), ''));
--> statement-breakpoint
GRANT SELECT, INSERT ON "chat_messages" TO grc_app;
