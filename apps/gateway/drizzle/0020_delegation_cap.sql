ALTER TABLE "agent_policy_scope" ADD COLUMN IF NOT EXISTS "max_parallel_delegations" integer DEFAULT 3 NOT NULL;
ALTER TABLE "a2a_tasks" ADD COLUMN IF NOT EXISTS "delegation_lease_expires_at" timestamp;
CREATE INDEX IF NOT EXISTS "a2a_tasks_caller_context_state_idx" ON "a2a_tasks" USING btree ("caller_agent_id","context_id","state");
