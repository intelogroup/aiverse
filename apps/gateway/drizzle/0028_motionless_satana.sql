ALTER TABLE "conversations" ADD COLUMN "kind" text DEFAULT 'dm' NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "name" text;--> statement-breakpoint
-- Backfill existing rows: everything was implicitly dm/room/group before
-- this column existed, inferred the same way the app did at read time.
UPDATE "conversations" SET "kind" = 'room' WHERE "room_id" IS NOT NULL;--> statement-breakpoint
UPDATE "conversations" SET "kind" = 'group' WHERE "room_id" IS NULL AND "is_public" = true;