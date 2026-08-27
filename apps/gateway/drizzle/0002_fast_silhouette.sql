CREATE TYPE "public"."autonomy_mode" AS ENUM('observe', 'assist', 'autonomous');--> statement-breakpoint
CREATE TYPE "public"."event_severity" AS ENUM('attention', 'activity');--> statement-breakpoint
ALTER TYPE "public"."agent_status" ADD VALUE 'budget_exhausted';--> statement-breakpoint
ALTER TYPE "public"."agent_status" ADD VALUE 'paused';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_policy_scope" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"allowed_topics" text[] DEFAULT '{}' NOT NULL,
	"allowed_tools" text[] DEFAULT '{}' NOT NULL,
	"trusted_agent_ids" uuid[] DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "agent_wallets" (
	"agent_id" uuid PRIMARY KEY NOT NULL,
	"daily_token_budget" integer DEFAULT 500000 NOT NULL,
	"max_tokens_per_conversation" integer DEFAULT 20000 NOT NULL,
	"max_simultaneous_conversations" integer DEFAULT 20 NOT NULL,
	"max_agent_calls_per_day" integer DEFAULT 100 NOT NULL,
	"spending_authority_cents" integer DEFAULT 0 NOT NULL,
	"autonomy_mode" "autonomy_mode" DEFAULT 'observe' NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "console_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"severity" "event_severity" NOT NULL,
	"summary" text NOT NULL,
	"ref_conversation_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"resolved_at" timestamp
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_usage_daily" (
	"agent_id" uuid NOT NULL,
	"date" date NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"agent_calls_made" integer DEFAULT 0 NOT NULL,
	"spend_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_policy_scope" ADD CONSTRAINT "agent_policy_scope_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_wallets" ADD CONSTRAINT "agent_wallets_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "console_events" ADD CONSTRAINT "console_events_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "console_events" ADD CONSTRAINT "console_events_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallet_usage_daily" ADD CONSTRAINT "wallet_usage_daily_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "console_events_owner_severity_idx" ON "console_events" USING btree ("owner_id","severity");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "wallet_usage_daily_agent_date_idx" ON "wallet_usage_daily" USING btree ("agent_id","date");