CREATE TYPE "public"."topic_source" AS ENUM('rule', 'ml');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_topics" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"confidence" integer DEFAULT 100 NOT NULL,
	"source" "topic_source" DEFAULT 'rule' NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_topics" ADD CONSTRAINT "message_topics_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_topics_topic_idx" ON "message_topics" USING btree ("topic");