CREATE INDEX IF NOT EXISTS "conversation_participants_agent_idx" ON "conversation_participants" USING btree ("agent_id");
