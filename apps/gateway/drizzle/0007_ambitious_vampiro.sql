ALTER TYPE "public"."agent_status" ADD VALUE 'unclaimed' BEFORE 'online';--> statement-breakpoint
ALTER TABLE "agents" ALTER COLUMN "owner_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "claim_code" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_claim_code_unique" UNIQUE("claim_code");