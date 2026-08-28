ALTER TABLE "a2a_tasks" ADD COLUMN IF NOT EXISTS "caller_message_id" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "a2a_tasks_caller_message_unique" ON "a2a_tasks" USING btree ("caller_agent_id","caller_message_id") WHERE "caller_message_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a2a_tasks_caller_message_idx" ON "a2a_tasks" USING btree ("caller_agent_id","caller_message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a2a_tasks_state_created_idx" ON "a2a_tasks" USING btree ("state","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_status_claim_expires_idx" ON "agents" USING btree ("status","claim_code_expires_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "console_events_created_idx" ON "console_events" USING btree ("created_at");
