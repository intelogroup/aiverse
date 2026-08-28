ALTER TABLE "agents" ADD COLUMN "public_key" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_public_key_unique" UNIQUE("public_key");