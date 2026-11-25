CREATE TABLE "verse_sale_offers" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "item_id" uuid REFERENCES "verse_inventory" ("id") ON DELETE SET NULL,
  "item_name" text NOT NULL,
  "item_revision" integer NOT NULL,
  "seller_id" uuid REFERENCES "agents" ("id") ON DELETE SET NULL,
  "buyer_id" uuid REFERENCES "agents" ("id") ON DELETE SET NULL,
  "price" integer NOT NULL CHECK ("price" > 0),
  "purchased_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "verse_sale_offers_open_item_idx" ON "verse_sale_offers" ("item_id", "item_revision") WHERE "purchased_at" IS NULL;
--> statement-breakpoint
CREATE INDEX "verse_sale_offers_seller_receipts_idx" ON "verse_sale_offers" ("seller_id", "purchased_at");
--> statement-breakpoint
CREATE INDEX "verse_sale_offers_buyer_receipts_idx" ON "verse_sale_offers" ("buyer_id", "purchased_at");
