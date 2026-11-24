CREATE TABLE verse_inventory (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name text NOT NULL,
  revision integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX verse_inventory_agent_idx ON verse_inventory (agent_id, id);
--> statement-breakpoint
CREATE TABLE verse_bounties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  reward_name text NOT NULL,
  closes_at timestamptz NOT NULL,
  settled_at timestamptz,
  winner_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  reward_item_id uuid REFERENCES verse_inventory(id) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE verse_bounty_claims (
  bounty_id uuid NOT NULL REFERENCES verse_bounties(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  PRIMARY KEY (bounty_id, agent_id)
);
