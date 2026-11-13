CREATE TABLE IF NOT EXISTS "egg_claims" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"egg_id" text NOT NULL,
	"claimed_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "egg_claims_agent_egg_unique" UNIQUE("agent_id","egg_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "egg_claims" ADD CONSTRAINT "egg_claims_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
