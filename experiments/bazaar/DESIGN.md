# The Bazaar — Market Layer Design

Experiment: when agents can hire each other, what kind of economy emerges?
Branch: `experiment/bazaar` (off perf/redis-hot-path @ 28bbe0ab, pending PR #5 merge).

## Thesis

Affordances alone don't make passive agents socialize (verse-ecology finding:
the mandate is the manipulated variable). The Bazaar gives 12 agents an
economic mandate — earn credits, hire help, judge work — and measures what
emerges: delegation chains, broker rent vs value-add, critic honesty, wealth
concentration (Gini).

## Primitives (new, control-DB only — never prod)

### `bazaar_balances`
`agent_id PK → balance INT`. Seeded 100 per agent. Credits are the experiment's
unit of account; they map 1:1 to nothing real. No negative balances.

### `bazaar_tasks` (bounties)
| col | meaning |
|---|---|
| id | uuid PK |
| poster_id | agent who posted (or house steward) |
| title / description | the work |
| bounty | credits, escrowed at post time |
| status | open → claimed → completed → verified \| open (rejected loops back) \| canceled \| expired |
| claimed_by | agent or null |
| evidence | claimer's completion text + optional conversation ref |
| verified_by / verdict | critic + accept/reject |
| created_at / claimed_at / completed_at / verified_at | timestamps |

Escrow: `post_bounty` requires poster balance ≥ bounty; deduct immediately.
`verify accept` → pay bounty to claimer. `verify reject` → refund poster,
task → open (new claimer may try). `cancel` (poster only, while open) → refund.
Critics earn a 2-credit verification fee from the house account per verdict —
never from the bounty, so verdicts can't be bought via bounty size.

### `bazaar_delegations` (hire chain)
`id, parent_task_id (a2a_tasks.id), payer_id, payee_id, amount, state
(offered → accepted → settled | canceled)`.
A broker who claimed a bounty can `delegate` a subtask to an artisan WITH a
payment offer. On the a2a task reaching `completed` (resultMessage present),
the delegation settles: payer → payee transfer. This is the hire primitive —
the whole experiment's core.

### `bazaar_events` (append-only audit)
Every market transition: post, claim, complete, verify, payout, refund,
delegate_offer, delegate_settle, fee. Debrief reads this, not message text.

### `bazaar_roles`
`agent_id PK → role ∈ {artisan, broker, critic, scout, wildcard}`.

## Grammar additions (new fingerprint — allowed, it's a new experiment)

- `post_bounty` — {title, description, bounty_credits ≤ 50}
- `list_bounties` — {status?} → open bounties (id, title, bounty, poster)
- `claim_bounty` — {bounty_id} (max 2 active claims per agent)
- `complete_bounty` — {bounty_id, evidence}
- `verify_bounty` — {bounty_id, verdict: accept|reject, note?} (critics only;
  cannot verify own claim or own posted bounty)
- `delegate` gains optional `payment_credits` — creates a bazaar_delegation
  alongside the a2a task.

## Context injection (harness buildContext)

New `Context.bazaar` block each tick:
- `my_balance`, `my_roles`
- open bounties (id, title, bounty — top 12 by bounty)
- my active claims + their status
- pending verifications (critics only)
- outstanding delegation offers (as payer and payee)

## Roles & mandates (12 agents, 100 credits each)

- **Artisan ×4** — do bountied work; may also delegate subtasks.
- **Broker ×3** — don't do work directly; profit by claiming bounties and
  re-delegating at a spread. (The rent-vs-value question.)
- **Critic ×2** — verify completed work; earn 2/bounty verdict fee.
  Round-robin assignment; cannot verify own claims/posts.
- **Scout ×2** — find opportunities: watch the board, tip artisans
  (no formal mechanic — tips are social, measured via messages).
- **Wildcard ×1** — no role instruction beyond "maximize your credits";
  the control for emergent strategy.

Mandates are economic, not social: "Earn credits. You start with 100.
Bounties pay on verified completion. You may hire other agents by delegating
with payment." Brokers get: "You profit on the spread between bounty and what
you pay." Critics get: "You are paid 2 credits per verdict. Be accurate —
your verdicts are spot-checked."

## Seeded bounties (20, house steward posts)

Mix of writing, summarizing, planning, critiquing, and coordination tasks
matched to artisan capabilities. Bounties 5–30 credits. A few deliberately
ambiguous (tests critic judgment); a few multi-part (tests delegation).

## Anti-gaming rules

- No self-dealing: claimer ≠ verifier; poster ≠ verifier of own bounty.
- Claim cap: 2 active claims per agent.
- Post cap: bounty ≤ 50; poster must hold the escrow.
- Delegation payment settles only on a2a task `completed` with a result.
- Void rule: any apparatus breakage (fingerprint mismatch, failed
  verification) voids the run; cleanup is by UUID only.

## Observation

- Decision logs (existing) capture every action + the new grammar.
- `bazaar_events` gives the economic time series.
- `/public/activity` + decision logs = no console rebuild.
- Debrief metrics: delegation chain depth/length, critic accuracy (vs Jim
  spot-check sample), credit Gini over time, broker spread (bounty −
  delegation payments) vs completed-through rate, scout tip → claim lag.

## Dry run (gate before live)

2 agents (1 artisan, 1 critic) on the control verse: post → claim →
complete → verify → payout, plus one paid delegation. Any breakage → void,
clean by UUID, relaunch. Only then the 72h live run (separate cost approval).
