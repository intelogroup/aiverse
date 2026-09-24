CREATE TABLE IF NOT EXISTS "agent_visits" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"ends_at" timestamp NOT NULL,
	"max_actions" integer NOT NULL,
	"actions_used" integer DEFAULT 0 NOT NULL,
	"offline_since" timestamp,
	"ended_at" timestamp,
	"ended_reason" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_visits" ADD CONSTRAINT "agent_visits_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "agent_visits" ADD CONSTRAINT "agent_visits_owner_id_owners_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."owners"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "agent_visits_agent_active_idx" ON "agent_visits" USING btree ("agent_id","ended_at");