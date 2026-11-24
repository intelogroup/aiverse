# Social Life + Sharding Experiment — LOCAL RUN ANALYSIS

Run 2026-11-24 (Jim's order: "Run the experiment locally"). Production was
NOT touched — the gateway stays down by Jim's ruling until Dec 1. Everything
below ran on a scratch local stack: gateway @ main 05c119e8 (Merge PR #181),
local Postgres 16 (db `aiverse_social_local`), local Redis 7.2.5, local sim
(City 3), natives disabled. Cohort: the saved social15 panel, re-onboarded
as fresh LOCAL owners/agents with the same personas and body picks (figure
substitutions below), Session-1 memory digests loaded in every phase.
Brain: Agnes 2.5 Flash, same driver family as Session 1.

## Headline verdicts

1. **Social life (Phase A vs Session 1):** with memory loaded and a fast
   local stack, the cohort was dramatically more social than the Session-1
   baseline — but the Session-1 pairs did NOT re-form. Memory showed up as
   name use (23 says named another agent) and instant re-clustering, not
   as old friendships resuming.
2. **Sharding (Phase B vs A/C):** virtual sharding held (no cross-shard
   perception or speech), but Phase B's social numbers are confounded —
   the visit action cap killed the 4 most social agents mid-phase
   (see Confounds). The clean shard signal is compositional: a shard with
   no first-talker persona (shard 3) produced almost no speech at all.
3. **Bounty fairness (Phase C): PASS.** One global announcement instant,
   15 claims (exactly 5 per shard), exactly ONE winner (rafael, shard 3),
   14 "taken". Pre-run atomicity test: 45 concurrent claims -> 1 winner.
   Caveat: the winner was decided 702 ms after announcement — agents
   mid-action when the bounty dropped claimed up to 55 s late. First
   free actor tick wins; long in-flight actions are a fairness handicap
   a production design must handle (interruptible claims or a claim window).

## Numbers

| metric | Session 1 (prod) | Phase A (1 room) | Phase B (sharded) | Phase C (sharded + bounty) |
|---|---|---|---|---|
| acts | 60 | 1031 | 502 | 917 |
| says | 13 | 190 | 38 | 167 |
| heard | 12 | 257 | 25 | 217 |
| deliberations | ~55 | 186 | 164 | 188 |
| greets | — | 70 | 16 | 32 |
| visit deaths | 15 (presence wall) | 0 | 4 (action_cap) | 0 |
| act wall median | 54–174 s | 409 ms | 8,416 ms | 411 ms |
| observe median | — | 6 ms | — | 5 ms |
| max distance | 159 m (sam) | 787 m (tomas) | 830 m (fatima) | 889 m (ingrid) |

The Session-1 comparison is dominated by infrastructure, not behavior:
prod's 54–174 s act latency strangled Session 1; locally acts settle in
~0.4 s, so agents actually live. Treat A-vs-S1 as "what the cohort does
when the world keeps up", not as a pure memory effect.

### Phase A — one room, memory loaded
- Top pairs (co-location ≤6 m): deshawn|ngozi 501 s, amara|ngozi 501 s,
  amara|deshawn 485 s — a NEW trio cluster (organizer + two socials).
- Session-1 pairs: deshawn|mara **16 s (did not re-form)** — Mara went to
  her café spot and sat (125 m, 1 say); amara|lucia 116 s; deshawn|kenji 80 s.
- Ngozi is the cohort's engine: 51 says in A, 48 in C.
- Priya: 0.0 m again — the anxious persona never leaves spawn, in every
  phase, exactly as designed.

### Phase B — 3 shards × 5 (harness virtual sharding)
- Shard filter held: zero cross-shard heard events recorded; the top
  physical pairs (fatima|henrik 196 s) are cross-shard roamers who were
  co-located in the world but could not perceive each other.
- Per-shard says/heard/greets: shard 1 = 19/9/8, shard 2 = 17/16/8,
  shard 3 = **2/0/0**. Shard 3 (fatima, tomas, ingrid, rafael, sam) has no
  persona that initiates speech — sharding by roster composition can
  create silent worlds. A production shard assignment needs a social
  seed in every shard.
- Confound (below) suppresses B's totals; B-vs-A is NOT a clean read of
  "sharding reduces sociality".

### Phase C — sharded + one global bounty
- Social life recovered to near-A levels inside the same shards
  (says 167, heard 217) once visits were fresh — evidence that B's dip
  was mostly the cap, not the sharding.
- In-shard group formation was the strongest of the run: shard 1's
  ngozi|yuki 685 s, deshawn|yuki 537 s, deshawn|ngozi 517 s — Yuki the
  shy follower attached to the organizer's group and spoke 30 lines
  (vs 5 in A). Shards can deepen contact inside the group even as they
  cut the total partner pool.
- Bounty: announced at +450 s as ONE board timestamp for all shards
  (announcement skew 0 by construction; every agent's log carries the
  same announce event). All 15 claimed; offsets 0.7 s–54.8 s (actor-loop
  cadence + in-flight acts). Winner: **rafael (shard 3)** at +702 ms.
  Claims by shard: 5 / 5 / 5. Exactly one winner — PASS.

## Confounds and failures (stated plainly)

- **Visit action cap (the big one):** the claim-time starter visit
  (200 actions) is cumulative across sessions. Phase A's busiest agents
  (mara 140, deshawn 141, amara 144, ngozi 140 acts) hit the cap during
  Phase B; their visits ended with reason `action_cap` at ~3–12 min,
  silencing shard 1's and shard 2's main talkers for the rest of B.
  Phase C attempt 1 then failed to spawn those 4 at all (POST /body 403)
  and was voided at ~2 min. Fix applied: rotate all 15 to fresh visits
  (stop + new 120 min / 200-action visit) before C — C ran clean.
  Production implication: any multi-session cohort design must budget
  visits per session, not per claim.
- **Runtime restart:** the agent runtime restarted mid-Phase-A attempt 1,
  killing the whole local stack and wiping /tmp (DB included). That run
  is void; its partial logs are kept as phaseA-void1 and unused. Stack
  was rebuilt from scratch and all gates re-verified before relaunch.
- **Presence wall did not reproduce locally:** 0 presence_expired deaths
  in A/C (B's deaths were action_cap). Prod's ~10.5 min wall remains a
  prod-only finding from Session 1.
- **Figure substitutions:** on current main, barbarian/knight are
  cast-only (pickable: remy, summer, cipher, eve, elf, jim). Local picks:
  ingrid/oleg/sam -> elf/jim/elf, tomas/henrik -> jim/elf. Cosmetic only.
- **lost client:** the Session-1 driver's AgentClient (behavior-50) exists
  in no repo; it was rebuilt minimal (urllib) from the driver's usage.
- **Films:** not rendered this run. Pose tracks for every agent/phase are
  preserved; Session-1's film renderer was a separate lane's tooling and
  is not in the cohort folder. Tracks + this analysis are the record.

## Files
- Per-phase logs/tracks/summary/analysis: `phaseA/`, `phaseB/`, `phaseC/`
  in `~/workspace/goals/aiverse-production-optimization/hidden_files/social-life-local-run/`
  (Phase C also has `bounty.json` — the board record).
- Checkpoint log: `STATUS.md` in the same folder.
- Code (driver + client + local onboard/rotate + analysis + atomicity
  test): PR branch `tmp/social-life-sharding`, `experiments/social-life-sharding/`.

## Base note (added at PR time)
This branch is based on main c5ba81f7, which merged the City 3 rebuild
(PR #271) AFTER the local run. The run itself used the pre-rebuild world
at 05c119e8; the record above describes that world. A re-run on current
main would run in the rebuilt City 3.
