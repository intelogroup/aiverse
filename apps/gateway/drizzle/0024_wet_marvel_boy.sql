ALTER TYPE "public"."goal_status" ADD VALUE 'accepted';--> statement-breakpoint
ALTER TYPE "public"."goal_status" ADD VALUE 'rejected';--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "task_outcomes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"task_id" uuid NOT NULL,
	"context_id" uuid NOT NULL,
	"target_agent_id" uuid NOT NULL,
	"caller_agent_id" uuid NOT NULL,
	"target_is_native" boolean NOT NULL,
	"caller_is_native" boolean NOT NULL,
	"state" "a2a_task_state" NOT NULL,
	"latency_ms" integer,
	"goal_accepted" boolean,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "task_outcomes_task_id_unique" UNIQUE("task_id")
);
--> statement-breakpoint
ALTER TABLE "goals" ADD COLUMN "accepted_at" timestamp;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_outcomes_target_state_idx" ON "task_outcomes" USING btree ("target_agent_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_outcomes_caller_state_idx" ON "task_outcomes" USING btree ("caller_agent_id","state");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_outcomes_context_idx" ON "task_outcomes" USING btree ("context_id");