# E1 pilot — BLOCKED at the smoke gate (2026-11-14)

**The pilot did not run. Spend: $0.000000 (ledger: 0 entries).**
No brain call was ever made: the block sits upstream of the brain.

## Evidence

Smoke run 2 (`runs/e1-a2-smoke-01-80d7af.jsonl`, footer):

    outcome: infra_failed
    reason:  gate: gateway gate: HTTP 403: {"error": "agent_unclaimed"}

Production's `POST /world/body` refuses a self-registered agent that
no owner has claimed. This is Jim's human-tap design (2026-11-13)
working as intended — claiming is an owner action in the console, and
the gateway auto-starts a starter visit at claim time
(STARTER_VISIT_MINUTES=120, STARTER_VISIT_ACTIONS=200, visits.ts).
Behind the claim gate sits the visit gate from PR #160 (merged
2026-11-13, in production 4ca120d5): every /world call needs an
active visit. The Nov 10–11 cold-probe flights predate both gates.

Smoke run 1 additionally exposed (and Phase 1 fixed) a real harness
bug: the gateway intermittently truncates chunked bodies in transit,
and the adapter crashed reading the truncated 403 body
(IncompleteRead). The adapter now guards the error-body read and a
run always leaves a footer. Suite: 64/64 offline tests green.

## Registered smoke agents (unclaimed, on production)

- `senses-e1-a2-smoke-01-684c12` — agentId 6fd5b0a5-7646-4a0d-8ead-bd995fa8d568
- `senses-e1-a2-smoke-01-80d7af` — agentId ee2504f4-6a44-4fae-af30-1b6ed3edb1dd

Registration responses (token + claim code) live only in
`~/workspace/.build-tmp/agent-senses/.secrets/*.reg.json` (0600).
They were never printed or logged.

## What unblocks the pilot (Jim's actions, by design)

1. Claim an experiment agent in the console (either smoke agent
   above, using its claim code, or a fresh registration). Claiming
   auto-starts the 120-minute / 200-action starter visit.
2. **Design collision to decide:** the Phase 1 brief registers a
   FRESH agent per run — under the claim gate that means 41 owner
   claims for one pilot, which is unreasonable. Workable shapes:
   (a) one claimed experiment agent reused across all 40 runs, with
   an owner-started long visit (visits can run up to 7 days /
   100,000 actions; a 40-run sequential pilot needs ~3–4 hours of
   visit wall time and roughly 200–320 counted actions); or
   (b) a small pool of claimed agents rotated across runs.
   The runner changes for (a)/(b) are small (skip register, load a
   stored token, same loop) once Jim picks the shape and the tap
   has happened.
3. Then re-run: `python3 harness/e1.py pilot` — no other changes
   needed. Expected pilot spend ≈ $0.15–0.25 of the $1.00 cap.
