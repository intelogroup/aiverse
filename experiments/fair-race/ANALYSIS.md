# E5 — Fair race at scale — analysis

Run: 2026-11-24, local stack, City 3, **100 agents** (social15 +
85 synthetic local-only personas, handles s85-*), 10 shards × 10
composition-seeded per E1's rule, agnes-3.0-flash, 1200 s. Global
bounty at the Great Hall (hall-0, point [34.5, -74]) announced at
main+1000 s (≈3 min into the run after the ~4 min spawn of 100
agents): travel there, claim on arrival; first claim opens a 10 s
window; window claims resolve together — nearest claimant within
25 m wins, else the earliest claim. Claim-window logic unit-tested
before the run (all cases pass). Raw outputs: `race1/`. Branch:
`tmp/fair-race`.

## Headline

**The window mechanism worked exactly as coded — and the race was
still decided by its fallback rule, because at 100 agents physical
travel broke down.** 59 of 100 agents claimed. The first claim —
which opened the window — came from **100.7 m away** (x23, a
synthetic in shard 6): its go_to never got it to the Hall before
the claim fired. Three claims landed inside the window, none
within 25 m, so the earliest — x23 — won without ever attending.
Meanwhile **17 agents physically reached the Hall** (claims at
0.5–21 m, oleg nearest at 0.54 m) but arrived after the window had
closed. Tick-order (the Phase C rule) would have picked the same
winner here; an arrival-based rule would have picked oleg.

## Why travel broke: the shared act pipeline is the scale wall

- Total acts: **1,564 across 100 agents in 1200 s ≈ 1.3 acts/s
  system-wide** — the same total throughput as the 15-agent runs
  (~1.4/s). The sim/gateway act pipeline does not scale with agent
  count on this stack; per-agent act rate fell ~7×.
- Act outcomes: done 523, arrived 313, **blocked 489 (31%)**,
  rejected 118, unavailable 60, timeouts ~56, post_failed 18.
- Claim distances are bimodal: 17 claims ≤ 25 m (arrived), 40
  claims at 73–116 m (essentially spawn distance). A cross-map
  go_to needs a POST, queueing, and minutes of walking; claim
  offsets ran 30–90 s after announcement — most bodies had barely
  moved when their claim fired. Only 10 agents were individually
  >70% blocked; the failure is systemic latency, not stuck agents.
- Deliberations: 428 total. The global Agnes pace throttled
  everyone to ~4–5 per agent regardless of class (cohort 72/15,
  synthetics 356/85) — the synthetics' stretched 240 s cadence
  never became the binding constraint; the shared limiter was.

## The design flaw the run exposed (name it plainly)

A claim from 100 m away should not open the window. The reflex
claimed unconditionally after issuing go_to (go_to returns on
timeout without an arrival check), so the window's clock started
on a non-arrival. **Fix for any rerun: a claim registers only when
the claimant is within range of the point (≤25 m); the window
opens on the first IN-RANGE claim.** With that gate, this run's
winner would have been decided among the 17 who actually arrived.

## Social life at 100

- Says per shard: 20–43 (heard 21–101) — compare E1's 15-agent
  shards at 8–85 says. The per-shard floor ROSE (min 20 vs 8):
  ten-agent shards with seeded synthetic talkers don't go silent
  the way five-agent shards did. Shard 9 is the quietest (21 says,
  21 heard).
- Total says 304, zero-say agents 26 of 100. Per-capita volume fell
  (deliberation starvation above), but no shard died.
- Winner x23 is synthetic; the nearest claimant (oleg, 0.54 m) is
  cohort. Claims came from all 10 shards.

## Confounds

- One run. Spawn took ~4 min (sequential), so the bounty landed
  ~3 min into the run rather than the designed +600 s of run time;
  agents had unequal warm-up (up to ~4 min spread).
- The 200-action visit cap never bound (0 visits died) — act
  starvation kept everyone far under it.
- "Blocked" outcomes at 31% may partly be body-crowding (100
  bodies pathing in the same city), not pure pipeline latency;
  the two are entangled in this data.
- Synthetic personas are scripted briefs, not Session-digest
  carriers; their social behavior is a floor model, not a
  population sample.
