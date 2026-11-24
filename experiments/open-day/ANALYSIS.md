# Open Day #1 — ANALYSIS (2026-11-24, local only)

Design: files/OPEN-DAY-MECHANICS-2026-11-24.md. One 20-minute open day,
all 15 social15 agents, instruction = "spend the day on the Verse" (no
goals in the deliberation prompt; personas unchanged). Agnes 2.5 Flash.
World: City 3 (hunt rig). Items: the hunt's 20 + Powers v1 (Lantern of
Seeing, Kettle of Rest, Terminal Keycard). Pose tracks kept
(work/cohort/openday1/tracks). Films not rendered (optional).

## Gates
- Unit checks (stack-free): 24/24 PASS — run cost = 2x walk, walk < drive
  < run; energy clamps 0..100; seated regen; XP ledger + by-source;
  conversation window (once per pair per 120 s); board -> store -> full
  reopen -> restore round-trip identical.
- Stack health: PASS (gateway ok/db ok/redis ok/natives disabled).
  Agnes preflight: PASS.
- Scripted energy check (fatima, real act path): PARTIAL — see Confounds.
  Proven across two attempts: walk 0.35/m exact, run per-metre > walk,
  exhaustion outcome with no POST, regen positive, recovery after rest.
- 1-agent smoke: PASS (energy 100->88 by movement; +50 XP all from
  first-place visits; clean cleanup).
- Full open day: COMPLETED, all 15 spawned 201/200, cleanup 15x
  DELETE 200 -> 404, zero visit deaths.

## What happened in the day
- **All 23 items collected** (feed: 23 collects). Final bags: yuki 5
  (incl. **Terminal Keycard** + Leaf Relic), lucia 3 (incl. **Kettle of
  Rest** + Ember Relic), kenji 2 (incl. **Lantern of Seeing**), ingrid 2
  (Sun Relic + Tide Pearl), oleg 2 (Star Relic), priya 2, and 1 each for
  amara, deshawn, fatima, henrik, mara, rafael, tomas. ngozi and sam: 0.
  Every power item was found and taken.
- **Activity mix:** go_to dominates (~1,680 of ~2,050 acts). A social
  burst formed in minute ~14-16 (bucket 7: 42 says, 38 face, 22 play —
  the day's one real gathering). run_to rose late (buckets 7-9:
  14/23/17) as agents hurried after the last items. Only 2 sit acts were
  deliberated; sitting mostly came from sitter/foodie policies.
- **XP table (total = score, same numbers in v1):**
  oleg 409, ingrid 315, kenji 307, lucia 299, sam 280, rafael 270,
  ngozi 251, tomas 245, amara 236, priya 227, deshawn 226, yuki 226,
  fatima 219, mara 205, henrik 186.
- **XP by source:** first-place visits are the faucet (oleg: 355 of 409
  from 71 places; the world has ~85 named places and every stall counts
  — exploration XP dwarfs the rest). Conversation XP was real money for
  the social agents: ngozi 136 (17 paid exchanges; she also led says,
  22), amara 96, deshawn 96, ingrid 80, mara 80, rafael 80. Collect XP:
  yuki 70 (best haul), lucia 50.
- **Energy:** bound only one agent hard — **sam** (edges/runner persona)
  drained to 1.3 and hit "exhausted_rest_needed" 4 times: the exhaustion
  path fired live, in the real driver, and he recovered by resting
  still. Everyone else's minimum was 53.7 (oleg) to 87.5: over 20
  minutes, walk costs (0.35/m) plus standing-still regen (+1/~4 s) make
  energy a soft pressure, not a binding one — except for runners.
- **Rest clustering:** resting happened at exactly ONE spot — the Tea
  House (-29.3, -75.7), 59 seated track samples, ~30 seated ticks in the
  first ~5 minutes (mara/rafael sitter patterns). But ZERO ticks had two
  agents seated within 12 m at the same time: the rest-spot social hub
  did NOT form in 20 minutes. Resting was solitary and early.
- **Optimization behaviour:** no explicit energy management was visible
  in deliberations (nobody chose "rest" to top up before a trip; the
  rest intent was never picked). What optimized was XP-shaped: the
  checklist/runner personas farmed first-visit XP by sweeping places,
  and item auto-targeting kept collectors flowing to the nearest item.
  Purpose DID appear versus the no-mechanics sessions — agents always
  had a next thing (an item, a new place, a conversation) — but it was
  the driver's item/place scaffolding plus XP visibility, not yet
  agent-invented goals.

## Persistence — PASS, all 15
Session fully ended (all bodies deleted), then:
1. verify_persistence.py: durable store bags == end-of-day summary bags
   for all 15 agents (PERSISTENCE_PASS, persistence-result.json).
2. A fresh driver process (new login, rotated visits) restored exactly
   the same bags at start — the printed restore line matches the
   end-of-day board item-for-item for all 13 holders; ngozi/sam empty
   in both. Bags also survived the mid-run 5 s sync + the energy-check
   and smoke processes sharing the rig earlier (separate stores).

## Confounds (honest)
- Scripted energy gate is PARTIAL: attempt 1 measured walk via the flat
  fallback (pre-pose staleness bug — fixed in openday.py and verified by
  attempt 2's exact 0.35/m); attempt 2's walk crawled (3.3 m in 90 s —
  the scripted harness has no stall watchdog; the real driver does) and
  in-flight server acts after driver timeouts contaminated the
  no-move-after-exhaustion measurement (9.21 m of drift was a still-
  running earlier act). The exhaustion OUTCOME itself (no POST issued)
  was verified cleanly both attempts, and sam's 4 live blocks in the
  full run corroborate the path end-to-end.
- XP "score" == XP in v1 (the brief's combined ledger). Jim's economy
  ontology (decided on the same call, after this lane's brief): credits
  are the money (stipends 1,000 first login / 200 per day), XP is
  growth only, Score is the audience leaderboard. That split — plus
  buy/use tools and stall snacks — is the NEXT layer, not in this run.
- Place XP counts every named place incl. each market stall; 71 places
  for oleg in 20 min makes exploration the dominant faucet. If XP is to
  signal "a year in the Verse", place awards need diminishing returns.
- Energy tuning is gentle for walkers at 20-min scale; whether it binds
  over a real day is untested (Jim declined a 24-h run — the 20-min day
  is the mechanics check).
- One run, one cohort, Agnes sampling unseeded: treat behaviour deltas
  as first signals, not measurements.

## Files
- Code: experiments/open-day/ on local branch tmp/open-day-mechanics
  (scratch repo, commit e5f3f820; NOT pushed). Working copies + DB +
  logs/tracks: hidden_files/open-day/work/cohort/ (openday.db,
  openday1/, relogin/, smoke/, energycheck/, analysis-data.json,
  persistence-result.json).
- The stack (gateway/sim) was left running as found (hunt-started;
  the program lane's E4 note says the same) — no driver processes of
  this lane remain.
