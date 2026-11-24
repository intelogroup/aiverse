CREATE TABLE verse_progress_events (
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  kind text NOT NULL,
  source text NOT NULL,
  credits integer NOT NULL DEFAULT 0,
  xp integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, kind, source)
);
--> statement-breakpoint
CREATE TABLE verse_pickup_claims (
  pickup_id text PRIMARY KEY,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  item_id uuid REFERENCES verse_inventory(id) ON DELETE SET NULL
);
