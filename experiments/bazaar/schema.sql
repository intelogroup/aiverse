-- Bazaar market tables — experiment-scoped, control DB (aiverse_control) ONLY.
-- Never applied to prod. Applied directly via psql (the control DB's drizzle
-- journal is mismatched by design; see AGENTS.md hard rule 7).
-- All tables prefixed bazaar_* so a control-DB inspection can tell
-- experiment state from platform state at a glance.

CREATE TABLE IF NOT EXISTS bazaar_balances (
  agent_id UUID PRIMARY KEY,
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0)
);

CREATE TABLE IF NOT EXISTS bazaar_roles (
  agent_id UUID PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('artisan','broker','critic','scout','wildcard'))
);

CREATE TABLE IF NOT EXISTS bazaar_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  poster_id UUID NOT NULL,
  title TEXT NOT NULL CHECK (char_length(title) BETWEEN 3 AND 200),
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 10 AND 4000),
  bounty INTEGER NOT NULL CHECK (bounty > 0 AND bounty <= 50),
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','claimed','completed','verified','canceled','expired')),
  claimed_by UUID,
  evidence TEXT,
  verified_by UUID,
  verdict TEXT CHECK (verdict IN ('accept','reject')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  claimed_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS bazaar_tasks_status_idx ON bazaar_tasks (status);
CREATE INDEX IF NOT EXISTS bazaar_tasks_claimed_by_idx ON bazaar_tasks (claimed_by);

-- Paid delegation: a broker (or anyone) hiring another agent for part of a
-- bounty. Settles payer -> payee when the linked a2a task completes.
CREATE TABLE IF NOT EXISTS bazaar_delegations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  a2a_task_id UUID NOT NULL UNIQUE,
  payer_id UUID NOT NULL,
  payee_id UUID NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  state TEXT NOT NULL DEFAULT 'offered'
    CHECK (state IN ('offered','settled','failed','canceled')),
  -- TRUE when the payer's amount was escrowed (debited) at offer time.
  -- Escrowed delegations settle payer -> payee from escrow; non-escrowed
  -- rows (legacy) still debit at settle and can 'fail' on insolvency.
  escrowed BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  settled_at TIMESTAMPTZ
);

-- Append-only economic audit log. Debrief reads this.
CREATE TABLE IF NOT EXISTS bazaar_events (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL,
  task_id UUID,
  actor_id UUID,
  counterparty_id UUID,
  amount INTEGER,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS bazaar_events_kind_idx ON bazaar_events (kind);
CREATE INDEX IF NOT EXISTS bazaar_events_task_idx ON bazaar_events (task_id);
