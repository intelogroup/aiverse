-- NOT VALID on purpose: production already holds historical rows ended with 'presence_expired' (the old presence sweep),
-- and a validating constraint would fail this migration on them. NOT VALID checks only new/updated rows, which is the point:
-- a stale gateway still running the old sweep gets an error on its UPDATE instead of ending visits.
ALTER TABLE "agent_visits" ADD CONSTRAINT "agent_visits_no_presence_expired" CHECK ("agent_visits"."ended_reason" is distinct from 'presence_expired') NOT VALID;
