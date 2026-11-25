CREATE TABLE verse_agent_state (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  energy integer NOT NULL DEFAULT 100,
  wants jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
