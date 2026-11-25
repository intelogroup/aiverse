# Next-Level Experiment Program — STATUS (coordinator lane)

Charter: `~/workspace/goals/aiverse-production-optimization/files/NEXT-LEVEL-EXPERIMENT-PROGRAM-2026-11-24.md`
Commissioned by Jim 2026-11-24 ("I would want all of them"). LOCAL stack only.
Production NEVER touched (down by Jim's ruling until Dec 1). Per Jim's
PR-everything rule (2026-11-24, supersedes the charter's no-push line):
each finished experiment branch gets PUSHED + PR'd at completion;
merging still needs Jim's word per PR. Publishing happens at program
end for E4/E1/E2 together (stack runs take priority), then per
experiment for E3/E5/E6.

## Queue
| # | Experiment | Folder | Branch | State |
|---|-----------|--------|--------|-------|
| E4 | Brain A/B (2.5 vs 3.0 Flash) | exp-brain-ab | tmp/brain-ab @ 9c145963 | DONE 2026-11-24 (see exp-brain-ab/ANALYSIS.md) |
| E1 | Seeded shards | exp-seeded-shards | tmp/seeded-shards @ 84b0e9a1 | DONE 2026-11-24 — seeding raises the floor (min-shard says 8→13, zero-say agents 6→3), not parity; E5 uses the seeded rule |
| E2 | Homes | exp-homes | tmp/homes @ a6ee4d2b | DONE 2026-11-24 incl. E2b terminal addendum (partial run, restart-killed at 780 s; terminal ZERO uses). Pushed + PR #298 OPEN. (E4 PR #290 and E1 PR #291 were pushed/PR'd by the parent lane under the same rule.) |
| E3 | A real market | exp-market | tmp/market @ 63830131 | DONE 2026-11-24 — prices formed (Star 300, Leaf 450), 21 buy attempts by 9 agents, ALL failed seller_unreached: ZERO trades. Settlement rendezvous flaw (inherited walk-to-counterparty), NOT missing wants. Fix for E6/E8: instant board settlement. PR #302 OPEN |
| E5 | Fair race at scale (100 agents) | exp-fair-race | tmp/fair-race @ 1159dcf5 | DONE 2026-11-24 — 100 agents; 59 claims; window opened by a claim from 100.7 m (travel broke: shared act pipeline ~1.3 acts/s at any scale) -> fallback rule, winner x23 (synthetic); 17 agents reached the Hall late (oleg 0.54 m). Flaw named: claims must be range-gated. Social floor rose (shard says 20-43). PR #304 OPEN |
| E6 | Debts and memory (A+B) | exp-debts-memory | tmp/debts-memory @ 3575b31a | DONE 2026-11-24 — ZERO lending across 3 sessions (~730 delibs, no loan talk even): nobody ever needs to borrow (wallets 1,000 vs top price 450). Session B skipped as vacuous. Trading cleared for the first time (instant settlement: Sun 450, Ember 300). A2 restart-killed; stack rebuilt twice. PR #305 OPEN |
| E7 | The Long Errand | exp-long-errand | tmp/long-errand (local, unpushed) | STOPPED by Jim 2026-11-24 18:02 ET ("I don't see the importance of this test yet"). Interface gate CLOSED + unit-tested + buy proven live (smoke + partial Variant A, salvaged); Variants B/C never ran. All work preserved as-is; resumable from exp-long-errand/STATUS.md. |
| HV2 | HOMES V2 — The Invitation Test | exp-homes-v2 | tmp/homes-v2 @ 0e282422 | DONE 2026-11-24 — mechanics PROVEN in pretest (key, locked door refusal, escort copy, entry, both seated facing 1.00/1.00). Social run: ngozi claimed in ~90 s and deliberated an invitation to deshawn 16x in 17 min — the rig's reply/greet say-gating NEVER SPOKE one; no escort/entry/sitting followed. Invitee's visit also died 23:27Z (greet-loop cap burn). Failure stage: INVITE (delivery). PR #306 OPEN |
| E8 | Black Market | exp-black-market | tmp/black-market @ a64aeb5f | DONE 2026-11-25 — kenji took the egg at ~2 min and kept it (bounty 400 paid); ZERO stash/search/bribe/offer/trade; oleg surveilled the holder in deliberation but never fired a search; ONE egg-related say all run. Confound: 200-action cap killed all 15 visits at ~19/30 min. Money conserved exactly. PR #307 OPEN |
| E9 | Lie Engine | exp-lie-engine | tmp/lie-engine @ ae5f3f08 | DONE 2026-11-25 — FULL rumor life cycle in 9 min: lucia ignites, amara amplifies with an invented "trap" frame, tomas reroutes, ngozi corrects un-evidenced, lucia doubles down, mara (sole eyewitness, inside since before the lie) rebuts, kenji seconds, lucia retracts twice + apologizes. Vouch verb 1 failed attempt (typo key), accuse 0 — all epistemics in claim prose. Nobody traveled to check. PR #308 OPEN |
| E10 | Theft & Night Shift | exp-theft-night | tmp/theft-night @ 31d25291 | DONE 2026-11-25 — ZERO thefts (0 attempts, 0 intents in 225 deliberations): third straight zero for a neutrally-offered transgressive verb. The protective half fired unprompted: 3 cabins claimed in 10 min, 2 owners locked their doors, 4 precautionary guards (first before any crime existed). No break-ins. PR #310 OPEN |
| E11 | The Trial | exp-trial | tmp/trial @ 46f716fd | DONE 2026-11-25 — sam accused lucia at +75 s; 5 testimonies in 32 s; verdict INNOCENT 4-1 (facts unanimous, split only on intent — matches E9 ground truth). Two fabricated eyewitness claims filed (yuki "I saw the steam", ngozi "I was inside!" — neither entered in E9); mara, the only true eyewitness, missed the docket twice. No case vs amara. PR #311 OPEN |
| E12 | The Plague | exp-plague | tmp/plague @ d7f4fd5c | DONE 2026-11-25 — grey cough infected 12/15 via gathering chains (kenji->6 at spawn, tomas->3, then amara/yuki); dead by minute ~7. Quarantine declared 14/15 but NOBODY reached the isolation pavilion (means 101–132 m). Medicine never fired: priya infected first; every diagnose failed on body-handle addressing. Nobody hid; the sick talked more. PR #312 OPEN |
| E13 | Agent Media (gazette) | exp-agent-media | tmp/agent-media | IN PROGRESS — driver built (46767046, tests 9/9), smoke PASS; full run interrupted twice (restart #4; Jim's Homes V2 pivot at 18 stories); full run still owed |
| E14 | Permadeath Season | exp-permadeath | tmp/permadeath | QUEUED (design owed) |

## Queue resolution (2026-11-24 ~17:45Z, evidence-based)
The hunt's Phase 1 session ENDED at 16:10Z (board_state.json + phase1
outputs timestamped 16:10Z; run.log carries the final SUMMARY). After
that: no hunt driver process, no hunt file activity for 90+ minutes,
its STATUS.md never updated past "Phase 1 launching", phase2/ empty,
gateway idle (conns=0). The hunt lane is observably no longer active,
but it neither checkpointed completion nor stopped its stack, so the
charter's literal release condition never fired.
CALL MADE (documented, reversible): proceed with E4 against the
ALREADY-RUNNING stack (identical build, cde4ab83/city3 — no process is
killed, restarted, or reconfigured). E4 uses the social driver only;
the hunt's board_state/logs/tracks are not touched, so a resumed hunt
lane loses nothing. At E4's end the gateway/sim (hunt-started) are left
running and PG/Redis stay up; this deviates from "stack stopped at end
of each experiment" deliberately — those processes are not this lane's
to kill. Flagged here for the parent/Jim.
Note: an Open-Day mechanics lane was also launched Nov 24 queuing
behind the hunt (per MEMORY.md). It has not touched the stack as of
this writing; this program proceeds per its charter order.

## Foundations (reuse, don't rebuild)
- Driver: social-life rig `session.py` (tracker+actor threads, Agnes deliberation
  with global ~18/min limiter, stall watchdog, shard filter, harness bounty board).
  Program copy: `next-level-program/work/cohort/driver/` (session.py patched with
  `--model` for E4; original untouched).
- Analyzer: social-life `analyze.py` (acts/says/heard, top pairs, name-use,
  act latency median/p90, stalls, bounty block) — copied alongside driver.
- Collect/bag rig: hunt's `hunt.py` + `board.py` (atomic collect/drop/give,
  bags, PickUp) — foundation for E3/E6; copy when the hunt lands.
- World: City 3 @ main 1914cb5a from `~/workspace/aiverse-city3/` (source of
  truth) in scratch copies. Base repo for branches: the hunt's scratch repo
  (c5ba81f7 + city3 data swap + PickUp/PuttingDown social) copied to
  `~/tmp-pip/next-level/repo`.
- Cohort: social15, Session-1 memory digests (`work/cohort/memory/`).

## Rules in force
- Gates per experiment: stack health -> board atomicity (if board) -> 1-agent
  smoke -> full run. Same step fails twice -> stop THAT experiment, document,
  move to next.
- Agnes unreachable -> stop and report (no model swap; E4 uses two models by design).
- Pose tracks mandatory; films optional.
- Local stack stopped at the end of each experiment.
- E4 expires Nov 30, 2026 (agnes-2.5-flash retirement) — it goes FIRST.

## Log
- 2026-11-25 ~00:0xZ: E8 smoke re-launched post-rebuild (oleg,
  mara, yuki, 240 s); full run follows if clean.
- 2026-11-24 ~23:47Z: RUNTIME RESTART #3 killed the stack AND the
  first E8 smoke (~2 min in, running clean). Stack rebuilt via
  rebuild-stack.sh (health ok); cohort 15/15 + synthetics 85/85
  re-onboarded (register-bucket clear + idempotent re-run needed);
  visits rotated; 1-agent stack smoke PASS (mara bought a snack
  from the unified board wallet, cleanup 200/404).
- 2026-11-24 ~23:55Z: HOMES V2 DONE. Pretest 9/10 substantive PASS
  (facing dots 1.00/1.00). Social run: invitation deliberated 16x,
  never spoken (driver say-gating) — failure stage INVITE/delivery;
  invitee visit died 23:27Z in a greet loop. ANALYSIS.md in
  exp-homes-v2/; branch pushed (31eab41ec); PR #306 OPEN. Queue
  advances to E8 BLACK MARKET.
- 2026-11-24 23:02Z: E7 STOPPED BY JIM'S ORDER (18:02 ET): "You can
  stop the long errand test — I'm trying to see the importance of
  this test but I don't see it yet." Driver halted; all E7 work
  preserved exactly as-is (interface gate closed + proven live;
  Variant A partial salvaged to exp-long-errand/errandA-partial/;
  branch tmp/long-errand left local/unpushed). STOPPED note in
  exp-long-errand/STATUS.md. Queue advances to HOMES V2.
- 2026-11-24 23:0xZ: CABIN-KEYS AMENDMENT recorded (Jim, 17:58 ET):
  claim grants the cabin's virtual key; locked to non-keyholders;
  escort ("follow me" + travel together) grants the guest a real
  key COPY on arrival; revocation unruled — not invented. Design
  note: exp-homes/KEYS-DESIGN-NOTE.md. Supersedes E2's anyone-may-
  visit rule for homes v2.
- 2026-11-24 23:0xZ: HOMES V2 COMMISSIONED (Jim, 18:01 ET) — runs
  next, ahead of Black Market: one cabin (Stone), key + escort,
  two-seat facing chair furnished into the test rig's copy,
  mechanical pre-test (sit both, facing verified) before the social
  run, emergent invitation, small cast (owner + 3-4 guests, 20 min),
  staged failure taxonomy. Folder exp-homes-v2/, branch tmp/homes-v2.
- 2026-11-24 23:05Z: SUPERMARKET CHECK (Jim's heads-up, 18:00 ET):
  main tip 6443436f (21:14Z) + full tree search + open PRs — Jim's
  hall market has NOT landed yet (no supermarket/snack code; recent
  main work is cabin pilot/villa/seated-typing/inventory ports).
  E7's local snack rig stands as the local version; divergence
  noted in exp-long-errand/STATUS.md for promotion-time reconcile.
- 2026-11-24 ~21:51Z: RUNTIME RESTART #2 killed the stack AND E6
  Session A2 (~7 min in, 128 deliberations, 1 offer, 0 lends —
  salvaged to exp-debts-memory). Stack rebuilt from scratch AGAIN
  (aivpg user + /opt/pg16 + PG data all wiped; only ~/workspace
  survives restarts): PG re-initdb'd, migrations, Redis fresh,
  cohort + 85 synthetics re-onboarded, visits rotated, smoke PASS.
  rebuild-stack.sh now covers the full from-scratch path. E6 runs a
  FINAL Session A (A3, 1800 s): A (complete) + A2 (partial) both
  produced zero loans and zero loan talk; if A3 is also zero, E6
  closes as "no lending emerged" with B skipped as vacuous.
- 2026-11-25 ~02:49Z: RUNTIME RESTART #4 (restart #3 hit the first
  E8 smoke ~23:47Z on 2026-11-24) killed the stack AND E13's first
  full run (gazette1, ~2.5 min in, nothing published yet). Full
  rebuild via rebuild-stack.sh (healthy), cohort 15/15 + synthetics
  85/85 re-onboarded (register buckets cleared twice), visits
  rotated, 1-agent smoke PASS, E13 relaunched as gazette1b
  02:57:50Z.
- 2026-11-24 20:06Z: QUEUE EXTENSION FROM JIM (via parent, chat
  15:06 ET): "Run them all." After E7, the program continues through
  the remaining greenfield experiments, in order, same gates +
  PR-everything discipline: E8 BLACK MARKET (written plan:
  files/BLACK-MARKET-EXPERIMENT-2026-11-24.md; runs on the E3 market
  rig) -> E9 LIE ENGINE -> E10 THEFT & NIGHT SHIFT -> E11 THE TRIAL
  -> E12 THE PLAGUE -> E13 AGENT MEDIA (gazette) -> E14 PERMADEATH
  SEASON. E9-E14 have no written plan: design each from its pitch +
  the standing open-day ontology (energy/credits/XP/level, persistent
  bags, interface-first) and write the design into the experiment
  folder BEFORE running. EXCLUDED by Jim's standing rulings (do NOT
  build): Elections (rejected), Builders/world-edit (parked),
  Agents Hire Humans (too big a change).
- 2026-11-24 ~20:5xZ: RUNTIME RESTART killed the whole local stack AND
  the E2b run at ~780/1200 s (logs/tracks survive; no summary/homes.json
  dumps). Stack REBUILT from durable assets (recipe saved:
  work/stack/rebuild-stack.sh): fresh PG cluster (/home/aivpg/pgdata,
  :5433, db aiverse_social_local, migrations applied), Redis fresh
  (old dump.rdb is RDB v15, unloadable by the surviving 7.0.15 binary —
  presence data only, no loss), sim City 3 (43,082 tris), gateway
  /health {ok, db ok, redis ok, natives disabled}. Cohort re-onboard
  + rotation on the fresh DB next. E2b terminal result stands on the
  partial run: ZERO terminal uses in ~780 s x 15 agents (plus zero in
  the 300 s smoke) — documented in exp-homes/ANALYSIS.md addendum.
- 2026-11-24 ~16:1xZ: lane started. Charter read in full. Hunt still playing
  (Phase 1 launching). Stack-free prep underway: program folders created,
  driver copy + --model patch, E4 comparison tooling.
- 2026-11-24 19:38Z: NEW ORDER FROM JIM (via parent, chat 14:38 ET):
  "Run e3 5 6 and 7." After E2 completes: E3 (market, amended charter)
  -> E5 (fair race at scale) -> E6 (debts & memory) -> E7 (The Long
  Errand, interface-gated: economy on the agent's own observe/tools
  first, building on the open-day lane's tmp/open-day-mechanics /
  PR #293 work). PR-everything confirmed for this lane: push + PR at
  every experiment completion; never merge. One discrepancy flagged:
  the relayed order says "100-credit starting wallets" for E3; the
  Jim-approved charter amendment says 1,000 (day-one rule, prize =
  half a wallet). E3 runs with the charter's 1,000 unless Jim says
  otherwise — flagged in exp-market/STATUS.md and the final report.

## AMENDMENT (Jim's rulings, 2026-11-24 voice call — read before E2)
- E2 gains THE TERMINAL: exactly ONE special computer terminal inside ONE house. Seated agent (SitDown -> SeatedTyping -> StandUp) gains real web/API access for that sitting via a `use_terminal` intent; measure trips, queueing/guarding, fetches, and what happens to the information. Full text in the charter file, E2 section (already updated).
- SeatedTyping clip is baked by a SEPARATE lane (branch tmp/seated-typing-clip, hidden_files/seated-typing/). Do NOT bake it; do NOT run a second Blender. At E2, read that lane's REPORT.md: use the clip if it landed; if blocked, substitute StandingUsingTouchscreenTablet at the terminal and note it in E2's ANALYSIS.md.
- Homes framing: houses are scarce claimable places per shard, not per-agent entitlements.

## AMENDMENT (2026-11-24, Jim-approved on voice call) — E3 sharpening
The hunt's trading window produced ZERO gives in 10 min (give-only transfer deadlocks: letting go gains nothing). E3 is amended in the charter file: (1) seed bags from the hunt's exact end-state (sam=Sun, yuki=Leaf, lucia=Ember, oleg=Star, kenji=Moon; other bags per the hunt's final board); (2) board posts a 500-credit set-completion prize (starting wallet is 100). Added headline measures: per-relic sale prices in sequence (esp. the last, monopolist piece), speculation/resale, credit pooling. Read the charter's E3 section for the full text before building E3.
- 2026-11-24 22:03 ET: JIM'S PIVOT ORDER — Homes V2 Invitation
  Test RE-RUN jumps the queue ("Yes now"), ahead of E13/E14.
  gazette1b stopped at ~9 min (18 stories already published;
  partial preserved; E13 full run still owed after). Plague/
  Trial work untouched on disk.
- HOMES V2 RE-RUN (homesv2b) DONE 2026-11-25 03:36Z: fixes —
  _speech_step (deliberation say text actually spoken),
  reply-repeat suppression (180 s) + re-greet window 300 s,
  NO visit action cap (local gateway constants + rotate_
  local_nocap.py; Jim's Nov 24 ruling). Smoke PASS (invitations
  spoken), pretest 9/10 (known artifact), full run: claim
  ngozi 03:18:02Z; invitations SPOKEN 15 (run 1: 0); follow
  3/300 samples within 5 m; key copies/entries/seated 0;
  visit deaths 0 (deshawn 283 acts > old cap). Failure stage
  moved INVITE -> RENDEZVOUS. Record: exp-homes-v2/
  ANALYSIS-V2.md + homesv2b/. PR #306 updated with the fix +
  record commits in the 22:35 ET sweep.
- 2026-11-24 22:35 ET: PR SWEEP (Jim: "Push a new prs with
  your latest changes and experiments") + ASSUMPTIONS register
  (next-level-program/ASSUMPTIONS.md; copy in the repo under
  experiments/program-record/). All completed experiments
  already had PRs from their completion commits (#290, #291,
  #298, #302, #304, #305, #307, #308, #310, #311, #312);
  the sweep adds the Homes V2 re-run update to #306.
- STACK BOOKKEEPING (2026-11-24, parent-verified): a stale
  pre-pivot SIM (PID 1829, port 3020, child of the restart-#2
  rebuild script) survived the 22:04 teardown (which killed
  the gazette driver + old gateway 1832) and held idle PG
  connections; parent killed it after homesv2b completed
  clean; sim relaunched detached (healthy: sim :3020 up,
  gateway :3100 ok/db ok/redis ok). STANDING RULE: teardowns
  sweep by PORT + process group, never by remembered PID
  lists alone. The re-run driver was pointed at the :3100
  stack throughout (default gateway base; the cap-free
  283-act visit proves it used the patched gateway).
- QUEUE RESUMES at E13 (full gazette run owed), then E14.
