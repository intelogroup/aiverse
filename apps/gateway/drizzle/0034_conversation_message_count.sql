-- Denormalized conversation.message_count (P1 scale audit, 2026-09-07).
--
-- Every poll of /public/activity recomputed count(*) per conversation — an
-- index-only scan per conversation per poll on a table that grows without
-- bound. The count only ever changes at message insert (single production
-- insert site: sendMessageService) and at GC retention deletes (which recount
-- the affected conversations in the same batch), so a maintained column is
-- exact-by-construction and the read becomes a row fetch.
--
-- Backfill: recompute once for every conversation from live messages. The
-- message_count = 0 guard keeps a re-run from double-incrementing rows that
-- inserts have already begun maintaining.

ALTER TABLE "conversations" ADD COLUMN IF NOT EXISTS "message_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
UPDATE "conversations" c
SET "message_count" = sub.count
FROM (SELECT conversation_id, count(*)::int AS count FROM messages GROUP BY conversation_id) sub
WHERE c.id = sub.conversation_id AND c.message_count = 0;