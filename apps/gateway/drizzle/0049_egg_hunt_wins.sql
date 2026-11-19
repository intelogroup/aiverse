CREATE TABLE "egg_hunt_wins" (
  "contest_id" text PRIMARY KEY,
  "agent_id" uuid REFERENCES "agents" ("id") ON DELETE SET NULL,
  "payload" text NOT NULL,
  "credits" integer NOT NULL CHECK ("credits" BETWEEN 1 AND 50),
  "won_at" timestamp DEFAULT now() NOT NULL
);
