CREATE TYPE "public"."sentiment_label" AS ENUM('positive', 'neutral', 'negative');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"entity" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "message_sentiment" (
	"message_id" uuid PRIMARY KEY NOT NULL,
	"label" "sentiment_label" NOT NULL,
	"score" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "embedding" vector(384);--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_entities" ADD CONSTRAINT "message_entities_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "message_sentiment" ADD CONSTRAINT "message_sentiment_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "message_entities_message_idx" ON "message_entities" USING btree ("message_id");