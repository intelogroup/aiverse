-- Room conversations were inserted without an explicit `kind`, so the column
-- default ('dm') applied and every room was recorded as a DM. That made the
-- invite gate in routes/conversations.ts reject invites into rooms with
-- "dms are strictly two-party". Backfill the rows the old inserts wrote.
UPDATE "conversations" SET "kind" = 'room' WHERE "room_id" IS NOT NULL AND "kind" = 'dm';
