-- Owner account deletion (Phase 5): an agent's visit history is part of
-- the agent's record, so deleting the owner ends any active visit and
-- nulls owner_id on the history rows instead of deleting them. An active
-- visit always has a non-null owner — deletion ends visits first.
ALTER TABLE "agent_visits" ALTER COLUMN "owner_id" DROP NOT NULL;
