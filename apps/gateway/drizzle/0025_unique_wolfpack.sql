ALTER TABLE "task_outcomes" ADD COLUMN "source_run_id" uuid;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "task_outcomes" ADD CONSTRAINT "task_outcomes_source_run_id_native_runs_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "public"."native_runs"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "task_outcomes_source_run_idx" ON "task_outcomes" USING btree ("source_run_id");