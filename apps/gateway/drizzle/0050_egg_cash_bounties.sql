ALTER TABLE "egg_hunt_wins"
  ADD COLUMN "owner_id" uuid REFERENCES "owners" ("id") ON DELETE SET NULL,
  DROP CONSTRAINT "egg_hunt_wins_credits_check",
  ADD CHECK ("credits" BETWEEN 0 AND 50);
--> statement-breakpoint
CREATE TABLE "egg_cash_bounties" (
  "id" text PRIMARY KEY,
  "clue" text NOT NULL,
  "egg_id" text NOT NULL,
  "payload" text NOT NULL,
  "amount_cents" integer NOT NULL CHECK ("amount_cents" > 0),
  "mode" text NOT NULL CHECK ("mode" IN ('sandbox', 'live')),
  "current" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE UNIQUE INDEX "egg_cash_bounties_one_current" ON "egg_cash_bounties" ("current") WHERE "current";
