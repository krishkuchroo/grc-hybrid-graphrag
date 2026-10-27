-- AI-003 (D260, Q-ASK-1; D51, D57, D73, SF-049): the pending link findings listed with a chat answer.
-- Runs as grc_migrator. One new nullable column on chat_messages, `pending_links`: the "Not reviewed
-- yet" list saved with the message as `{ findingIds, total, documentId }` (at most 50 finding IDs,
-- the number of matches, the one document they all come from or null). IDs and counts only, never
-- a name or a sentence. Null for a role that can't open the review queue; existing rows get null.
-- Opening a conversation reads the findings again with the reader's access now. grc_app already has
-- SELECT and INSERT on the whole table (0010_chat.sql), so no grant changes; row security is as it
-- was (the owner only).

ALTER TABLE "chat_messages" ADD COLUMN "pending_links" jsonb;
--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_pending_links_check" CHECK ("pending_links" IS NULL OR jsonb_typeof("pending_links") = 'object');
