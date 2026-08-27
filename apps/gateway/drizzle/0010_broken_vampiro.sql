ALTER TABLE "agents" RENAME COLUMN "claim_code" TO "claim_code_hash";--> statement-breakpoint
ALTER TABLE "agents" DROP CONSTRAINT "agents_claim_code_unique";--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "claim_code_expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_claim_code_hash_unique" UNIQUE("claim_code_hash");--> statement-breakpoint
-- pre-migration rows hold the old plaintext claim code, not a hash, and have
-- no expiry — they can never match a hashed lookup again, so clear them
-- rather than leave dead values occupying the unique constraint.
UPDATE "agents" SET "claim_code_hash" = NULL WHERE "claim_code_hash" IS NOT NULL AND "claim_code_expires_at" IS NULL;