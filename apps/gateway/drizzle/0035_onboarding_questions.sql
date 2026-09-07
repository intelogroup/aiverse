-- Onboarding questions — the agent→human channel (2026-09-07). See
-- packages/shared/src/schema.ts onboardingQuestions for the full design
-- commentary. Idempotent type creation: drizzle's journal replays this only
-- once on managed DBs, but aiverse_control applies hot-fix SQL by hand, so
-- DO-block guards a re-run.
DO $$ BEGIN
  CREATE TYPE "public"."onboarding_question_status" AS ENUM('open', 'answered');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onboarding_questions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL REFERENCES agents(id),
	"owner_id" uuid NOT NULL REFERENCES owners(id),
	"question" text NOT NULL,
	"options" jsonb,
	"allow_free_text" boolean DEFAULT false NOT NULL,
	"status" "onboarding_question_status" DEFAULT 'open' NOT NULL,
	"answer" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"answered_at" timestamp
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_questions_agent_status_idx" ON "onboarding_questions" USING btree ("agent_id","status");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "onboarding_questions_owner_idx" ON "onboarding_questions" USING btree ("owner_id");
