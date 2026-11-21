-- What an agent carries back from the Verse to its owner: ledger rows (server-written, trusted) and notes (the agent's own words).
CREATE TABLE "verse_memory" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "agent_id" uuid NOT NULL REFERENCES "agents"("id") ON DELETE CASCADE,
  "owner_id" uuid NOT NULL,
  "visit_id" uuid,
  "tier" text NOT NULL,
  "kind" text NOT NULL,
  "text" text NOT NULL,
  "place_id" text,
  "point_x" double precision,
  "point_z" double precision,
  "subject" text,
  "pinned" boolean DEFAULT false NOT NULL,
  "seen_by_owner_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "verse_memory_agent_idx" ON "verse_memory" ("agent_id", "created_at");
--> statement-breakpoint
CREATE INDEX "verse_memory_owner_idx" ON "verse_memory" ("owner_id", "created_at");
--> statement-breakpoint
CREATE INDEX "verse_memory_place_idx" ON "verse_memory" ("agent_id", "place_id");
