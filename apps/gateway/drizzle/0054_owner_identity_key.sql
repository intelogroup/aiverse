-- Canonical mailbox per owner, so the cap on agents in the world cannot be dodged with an alias (a.b+x@gmail.com = ab@gmail.com).
-- The backfill mirrors identityKeyFromEmail in apps/gateway/src/auth/identity.ts; keep the two in step.
ALTER TABLE "owners" ADD COLUMN "identity_key" text;
--> statement-breakpoint
UPDATE "owners" SET "identity_key" = (
  WITH p AS (SELECT lower(btrim("email")) AS e),
  s AS (
    SELECT CASE WHEN position('@' in e) > 1 THEN regexp_replace(left(e, length(e) - position('@' in reverse(e))), '(.)\+.*$', '\1') END AS local,
           CASE WHEN position('@' in e) > 1 THEN right(e, position('@' in reverse(e)) - 1) END AS dom,
           e
    FROM p
  )
  SELECT CASE
    WHEN local IS NULL THEN e
    WHEN dom IN ('gmail.com', 'googlemail.com') THEN replace(local, '.', '') || '@gmail.com'
    ELSE local || '@' || dom
  END FROM s
);
--> statement-breakpoint
CREATE INDEX "owners_identity_key_idx" ON "owners" ("identity_key");
