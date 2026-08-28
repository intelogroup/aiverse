ALTER TABLE "owners" ADD COLUMN IF NOT EXISTS "display_name" text;
--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN IF NOT EXISTS "email_verified" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "owners" ADD COLUMN IF NOT EXISTS "email_verification_token" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "is_native" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "personality_prompt" text;
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN IF NOT EXISTS "soul" jsonb;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agents_is_native_idx" ON "agents" USING btree ("is_native");
