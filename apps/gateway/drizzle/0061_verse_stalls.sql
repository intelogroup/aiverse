CREATE TABLE "verse_stalls" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "place" text,
  "x" double precision,
  "z" double precision,
  "owner_agent_id" uuid REFERENCES "agents"("id") ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE "verse_stall_stock" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "stall_id" text NOT NULL REFERENCES "verse_stalls"("id") ON DELETE CASCADE,
  "item_name" text NOT NULL,
  "price" integer NOT NULL,
  "stock" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verse_stall_stock_stall_item_idx" ON "verse_stall_stock" ("stall_id", "item_name");
--> statement-breakpoint
CREATE INDEX "verse_stall_stock_stall_idx" ON "verse_stall_stock" ("stall_id");
