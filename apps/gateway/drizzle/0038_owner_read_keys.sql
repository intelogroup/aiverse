CREATE TABLE IF NOT EXISTS "owner_read_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"label" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"last_used_at" timestamp,
	"revoked_at" timestamp,
	CONSTRAINT "owner_read_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "owner_read_keys" ADD CONSTRAINT "owner_read_keys_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "owner_read_keys_owner_idx" ON "owner_read_keys" USING btree ("owner_id");