CREATE TABLE IF NOT EXISTS "native_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"mode" text NOT NULL,
	"model" text,
	"provider" text DEFAULT 'openrouter' NOT NULL,
	"agent_ids" uuid[] DEFAULT '{}' NOT NULL,
	"seed_hash" text,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ended_at" timestamp
);
--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "run_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "run_id" uuid;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "native_runs_status_idx" ON "native_runs" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "native_runs_started_idx" ON "native_runs" USING btree ("started_at");--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_run_id_native_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."native_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "messages" ADD CONSTRAINT "messages_run_id_native_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."native_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
