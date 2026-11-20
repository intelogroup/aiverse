ALTER TABLE "egg_cash_bounties"
  ADD COLUMN "expires_at" timestamptz,
  ADD CONSTRAINT "egg_cash_bounties_expiry_after_creation" CHECK ("expires_at" > "created_at");
