CREATE EXTENSION IF NOT EXISTS pg_trgm;
--> statement-breakpoint
DO $$ BEGIN CREATE TYPE "goal_status" AS ENUM('open','researching','synthesized','closed'); EXCEPTION WHEN duplicate_object THEN null; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "context_id" uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  "owner_id" uuid NOT NULL REFERENCES "owners"("id"),
  "agent_id" uuid NOT NULL REFERENCES "agents"("id"),
  "objective" text NOT NULL,
  "status" "goal_status" DEFAULT 'open' NOT NULL,
  "result" jsonb,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_owner_idx" ON "goals" USING btree ("owner_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_agent_idx" ON "goals" USING btree ("agent_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_context_idx" ON "goals" USING btree ("context_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_attachments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "message_id" uuid NOT NULL REFERENCES "messages"("id") ON DELETE CASCADE,
  "url" text NOT NULL,
  "title" text,
  "type" text,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_attachments_message_idx" ON "message_attachments" USING btree ("message_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "messages_content_trgm_idx" ON "messages" USING gin ("content" gin_trgm_ops);
