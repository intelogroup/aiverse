# E1 — Seeded shards — ANALYSIS

Played 2026-11-24, local stack only (production untouched). social15,
City 3, Session-1 digests, agnes-3.0-flash (E4 anchor), 900 s per arm,
3 shards x 5, no bounty, fresh visits per arm. Arm A = this morning's
Phase B/C shard map verbatim. Arm B = snake draft by Phase A initiative
(says+greets), one top-3 seed (ngozi/deshawn/amara) per shard.
Branch tmp/seeded-shards. Data: armA/, armB/ (logs, tracks, analysis.json).

## Headline
**Seeding raises the floor; it does not level the room.** The quiet
shard got less quiet, total listening more than doubled, but the spread
between loudest and quietest shard stayed wide — because the seed
signal itself is unstable: an agent's initiative in one session is a
weak predictor of the next.

## Per-shard says / heard (the rescue metrics)
| | Arm A (baseline map) | Arm B (seeded) |
|---|---|---|
| Shard 1 | 85 / 94 | 83 / 184 |
| Shard 2 | 17 / 16 | 32 / 38 |
| Shard 3 | **8 / 7** | **13 / 32** |
| Total | 110 / 117 | 128 / 254 |
| Zero-say agents | 6 of 15 | 3 of 15 |
| Visits died | 1 | 0 |

Baseline replication check: Arm A's shard 3 (ingrid/tomas/fatima/
rafael/sam) went near-silent AGAIN — 8 says, all 8 from ingrid alone,
0 greets — reproducing this morning's Phase B (2 says) on a new model
and a new world. The silent-shard phenomenon is real and compositional,
not a one-off.

## Why the rescue was only partial — the seed didn't fire
Arm B's shard 3 held amara (initiative 51, #3 in the cohort) and lucia
(39, #4). They produced 5 and 7 says. The seed, in this run, simply did
not talk much. Meanwhile:
- ngozi's shard (B1) hit 83 says — but the surprise is WHO: ingrid
  (26 says, vs 8 in Arm A) and mara (16, vs 0) bloomed next to her.
  The seed's effect looks less like "the seed talks" and more like
  "ngozi creates a room other people talk in."
- deshawn, the #2 seed, dropped from 36 says (Arm A, with ngozi) to 9
  (Arm B, heading shard 2). Initiative is contextual, not a trait.
- Arm B achieved its floor DESPITE worse infrastructure luck: 55% of
  its deliberations were rate-limit-rejected by Agnes's free tier
  (94/172) vs 40% in Arm A (75/189). The comparison is conservative —
  with equal deliberation yield the seeded arm's lead would likely grow.

## Verdict
- Composition seeding WORKS as floor insurance: no shard collapsed to
  near-zero, listening (heard) rose in every shard, and the number of
  completely silent agents halved. For E5's 10-shard assignment, use
  the seeded rule (it is the charter's "E1's winning rule").
- It does NOT deliver equal social life per shard. If parity is ever
  the goal, composition alone won't get there — the variance is in
  whether a given agent catches fire in a given session, which one
  session of history predicts poorly. A better seed signal would use
  multi-session initiative averages; we now have 4 sessions of data
  (S1, Phase A, E4 runs, E1 arms) to build it from.
- Sharding itself costs social volume: one-room E4 run = 300 says;
  sharded arms = 110-128 says at equal settings. Expected (fewer
  perceivable partners), worth stating as the price of the design.

## Confounds
- One run per arm; unseeded model sampling; per-agent initiative is
  demonstrably unstable across runs (above), which is itself a finding
  but also widens every error bar.
- Deliberation yield differed between arms (rate limiting, above) —
  against Arm B, so the seeding conclusion survives it.
- Pair-proximity numbers cross shard boundaries (agents physically
  co-locate across shards; only speech is filtered) — says/heard are
  the valid shard metrics, pairs are reported for texture only.
