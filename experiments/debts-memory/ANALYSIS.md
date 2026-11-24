# E6 — Debts & memory — analysis

Runs: 2026-11-24, local stack, City 3, one room, 15 agents,
agnes-3.0-flash, market rig + loans layer (lend/repay intents,
driver-spoken loan announcements, board-recorded debts), bags
seeded from the hunt end-state, wallets 1,000. Session A: 1200 s
(complete). Session A2: 1800 s planned, **killed ~7 min in by a
runtime restart** (128 deliberations salvaged). Session A3: 1800 s
(complete, after the second stack rebuild). Raw outputs:
`sessionA/`, `sessionA2/`, `sessionA3/`. Branch: `tmp/debts-memory`.

## Headline

**No lending emerged — not one loan, not one lend intent, not one
line of loan talk — across three market sessions and ~730
deliberations.** Session B was therefore skipped as vacuous: with
no debts in any digest, there is nothing for memory to carry, and
running B would have measured an empty set. The digest pipeline
itself was verified end-to-end (Session-2 digests written from A3
with the debts field present and fidelity-checked — trivially
exact, because the debt list is empty).

**Trading, by contrast, now works.** With E3's settlement flaw
fixed (buy settles on the board at acceptance), the program's
first trades cleared: in A, yuki bought sam's Sun Relic (450)
four seconds after it was offered; in A3, ingrid bought lucia's
Ember Relic (300) six seconds after the offer. Offers across the
sessions: A 2 (1 traded), A3 4 (1 traded). Prices are forming
around relics (300–450) — the market layer is alive; the credit
layer on top of it is not.

## Why no lending: nobody ever needs to borrow

The mechanism-level explanation is in the numbers. Every agent
starts with 1,000 credits. The most expensive thing anyone ever
wanted — a set relic — costs 300–450. The prize is 500. **No agent
is ever short.** Borrowing has no function in this economy: there
is no purchase a wallet can't cover, no expense, no uneven
endowment, no emergency. Lending, symmetrically, is a pure gift
of liquidity nobody needs, with repayment as pure downside risk.
The agents' behavior is not a memory failure or an affordance
failure — the lend intent sat in every prompt with an explicit
"debts are remembered across days" framing, and the loan-talk
count is exactly zero. They never even discussed it.

Contrast with trading: buying a relic DOES something (the set,
the prize). Trade is what wants do — and credit, it turns out, is
what scarcity does. No scarcity, no credit.

## What this means for the design (the useful output)

A lending economy needs a reason to be short. Any one of these
would change the experiment: a set piece priced ABOVE a single
wallet (e.g. the last relic at 1,500 — forcing pooling or a loan);
uneven starting wallets; a recurring expense (energy snacks priced
to matter, rent on homes); or a prize that pays for speed, making
a loan's time value real. Until one exists, debts-and-memory
cannot be tested, because there are no debts — the memory
machinery (digests with debts folded in verbatim, hidden-ledger
repayment matching) is built and unit-verified but behaviorally
untested. That is the honest state: **mechanism ready, phenomenon
absent.**

## Session notes and confounds

- A2's loss was infrastructure (runtime restart #2, which also
  wiped the whole local stack; rebuilt from scratch, cohort and
  synthetics re-onboarded). A2's partial data is kept and counted
  above; its 128 deliberations showed the same zero.
- Market behavior wakes late in every session (first offers at
  t+946/1200 in A, t+1388/1800 in A3). Sessions were long enough
  for trading to emerge and replicate; lending had the same
  exposure and produced not even talk. The asymmetry is the
  finding, not a duration artifact — though a still longer session
  can never be ruled out as a cure.
- The loans prompt text may err toward abstraction ("lending is
  normal here") without a concrete occasion. A future design
  should create the occasion in the world (scarcity), not in the
  prompt.
- Digest fidelity machinery (write_digests.py) is verified against
  an empty debt set only. Its per-debt checks passed in the board
  unit tests with synthetic debts; the live end-to-end with real
  debts remains unrun for the reason stated.
