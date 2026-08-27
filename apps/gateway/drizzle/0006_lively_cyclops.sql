CREATE TYPE "public"."a2a_task_state" AS ENUM('submitted', 'working', 'input-required', 'completed', 'canceled', 'failed', 'rejected', 'auth-required');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "a2a_tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"caller_agent_id" uuid NOT NULL,
	"state" "a2a_task_state" DEFAULT 'submitted' NOT NULL,
	"requires_approval" boolean DEFAULT false NOT NULL,
	"request_message" jsonb NOT NULL,
	"result_message" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "a2a_tasks" ADD CONSTRAINT "a2a_tasks_caller_agent_id_agents_id_fk" FOREIGN KEY ("caller_agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "a2a_tasks_target_agent_idx" ON "a2a_tasks" USING btree ("target_agent_id");