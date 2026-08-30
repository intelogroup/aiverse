DO $$ BEGIN CREATE TYPE "public"."goal_status" AS ENUM('open', 'researching', 'synthesized', 'closed'); EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "goals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"context_id" uuid DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"objective" text NOT NULL,
	"status" "goal_status" DEFAULT 'open' NOT NULL,
	"result" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "goals_context_id_unique" UNIQUE("context_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"url" text NOT NULL,
	"title" text,
	"type" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "a2a_tasks" ADD COLUMN IF NOT EXISTS "caller_message_id" text;--> statement-breakpoint
ALTER TABLE "a2a_tasks" ADD COLUMN IF NOT EXISTS "delegation_lease_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "agent_policy_scope" ADD COLUMN IF NOT EXISTS "max_parallel_delegations" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "is_native" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "personality_prompt" text;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "soul" jsonb;--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN IF NOT EXISTS "display_name" text;--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN IF NOT EXISTS "email_verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN IF NOT EXISTS "email_verification_token" text;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goals" ADD CONSTRAINT "goals_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "goals" ADD CONSTRAINT "goals_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_attachments" ADD CONSTRAINT "message_attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_owner_idx" ON "goals" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_agent_idx" ON "goals" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goals_context_idx" ON "goals" USING btree ("context_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_attachments_message_idx" ON "message_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a2a_tasks_caller_message_idx" ON "a2a_tasks" USING btree ("caller_agent_id","caller_message_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a2a_tasks_caller_context_state_idx" ON "a2a_tasks" USING btree ("caller_agent_id","context_id","state");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_caller_message_unique" UNIQUE("caller_agent_id","caller_message_id");
EXCEPTION
 WHEN duplicate_table THEN null;
 WHEN duplicate_object THEN null;
END $$;