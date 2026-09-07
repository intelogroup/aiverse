-- Hot-path indexes (2026-09-07 egress/scale audit).
--
-- 1) conversation_participants(agent_id): GET /conversations (the harness
--    resync, polled EVERY TICK per rule 16) filters participants by agent_id
--    and no index covered it — full-table scan per poll per agent. The
--    existing conversation_id index only served the write-side fan-out.
--
-- 2) messages FTS expression index: /public/search computes
--    to_tsvector('english', content) per row at query time — seq scan per
--    search (measured 105ms over 3,846 rows, grows linearly with the table).
--    This expression index lets the planner serve plainto_tsquery lookups
--    from the GIN index directly. Note 0019's messages_content_trgm_idx
--    serves the trigram/similarity path only — the FTS predicate needs its
--    own expression index, same pattern as the schema-side custom indexes
--    (not expressible in drizzle schema.ts, hence hand-written like 0018/0019).

CREATE INDEX IF NOT EXISTS "conversation_participants_agent_idx" ON "conversation_participants" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_content_fts_idx" ON "messages" USING gin (to_tsvector('english', "content"));