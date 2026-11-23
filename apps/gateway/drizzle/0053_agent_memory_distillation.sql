CREATE TABLE "visit_distillations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"visit_id" uuid NOT NULL,
	"agent_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"entries_written" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "visit_distillations_visit_id_unique" UNIQUE("visit_id")
);
--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "source_visit_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "entry_hash" text;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD COLUMN "embedding" vector(384);--> statement-breakpoint
ALTER TABLE "visit_distillations" ADD CONSTRAINT "visit_distillations_visit_id_agent_visits_id_fk" FOREIGN KEY ("visit_id") REFERENCES "public"."agent_visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "visit_distillations" ADD CONSTRAINT "visit_distillations_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_memory" ADD CONSTRAINT "agent_memory_source_visit_id_agent_visits_id_fk" FOREIGN KEY ("source_visit_id") REFERENCES "public"."agent_visits"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_memory_distilled_unique" ON "agent_memory" USING btree ("agent_id","source_visit_id","entry_hash");--> statement-breakpoint
CREATE INDEX "visit_distillations_status_idx" ON "visit_distillations" USING btree ("status","created_at");
