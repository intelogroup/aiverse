# NormSeed-1 — STATUS

## Commission
Phase 1 (design + build rig): can fresh agents infer/adopt an unstated community
norm (greet PLACE-FIRST, NAME-SECOND) from residents modeling it + social
feedback? Arms A (name-only control) / B (modeling only) / C (modeling +
feedback + 5-min persistence phase). 3 scripted residents + 3 fresh newcomers
per arm, 25-min sessions. A later lane runs the arms. AMENDMENT (Jim,
2026-11-12): harness modernization — schema-validated tool calls, turn
outcomes into context, within-run episodic memory, logged reasoning traces,
reflex discipline (no coded greetings/speech for newcomers; reflex acts tagged
+ excluded from metrics), reliability fixes, and a SMOKE GATE demonstrating
each property before any arm runs.

## Hard constraints
- Social15 cohort UNTOUCHABLE (read/copy only). Fresh disposable owners/agents.
- Agnes 2.5 Flash, ~50 s deliberation cadence, ~18/min global limiter,
  same closed intent set as Social15.
- Rotation OFF (presence wall fixed 2026-11-12: VA suspended + PR #147).
- Tracks for EVERY body in social15 tracks format (films).

## Progress
- [x] Read social15 session.py / onboard.py / client.py / syncvisits.py
- [x] Places: Tea House = shop-102 "Matchmaker's Tea House"; anchors picked:
      shop-102 (Tea House), shop-96 (Sage's Library), shop-58 (Bakery)
- [ ] Accounts path test (fresh owner register + verify route)
- [ ] norm.py matcher + hand-labeled unit tests
- [ ] onboard_ns.py (full cast registration)
- [ ] session_ns.py (newcomer tool-call harness + resident policies)
- [ ] scorer.py (+ reflex exclusion)
- [ ] gate_check.py + smoke gate run
- [ ] DESIGN.md + final report

## Cast (new names; no cohort names)
Residents (scripted, all arms): Wren @ Tea House (summer), Cato @ Sage's
Library (cipher), Mina @ Bakery (eve).
Newcomers: A: Theo (remy), June (elf), Alba (jim) | B: Ruth (summer),
Emil (cipher), Noor (eve) | C: Hugo (remy), Sana (elf), Vera (jim).

## Findings (2026-11-12)
- ACCOUNTS TEST (decisive): fresh owner registers 201; the verify email
  arrives ("Verify your AIVerse email") but the Gmail CLI returns only a
  [credential:...] handle — the token is NOT extractable from this
  sandbox. Claim by an unverified owner = 403 email_not_verified.
  => Verification of the 12 fresh owners must go through the parent-run
  browser credential flow (as Social15), then onboard_ns.py sync + claim.
  One probe owner (normseed-r1) + its agent were burned in the test
  (unsaved password); res-wren moved to alias normseed-r1b.
- heard[].name = AGENT REGISTRATION NAME (e.g. "s15-ingrid"), not the
  persona name. onboard_ns tries plain persona names first ("Wren"...),
  then ns-<name> fallbacks; matcher anchors intros on persona names.
- Matcher: 35/35 hand-labeled cases pass (driver/test_norm.py).
- Validator sanity: good call accepted; prose rejected (no salvage);
  missing args / bad clip / dual go_to targets rejected with precise
  errors.
- [x] driver files written: cast.py, norm.py (+35/35 tests),
      onboard_ns.py, session_ns.py, scorer.py, gate_check.py
- [x] validator sanity checks pass (prose rejected, no salvage)
- [x] registration: 12/12 owners + 12/12 agents (plain persona names)
- [x] LEAK AUDIT: NONE — 9 briefs + 118 newcomer-code literals scanned
      for norm-adjacent tokens; resident reply pools place-free
- [x] offline harness self-test: ALL 5 properties PASS in code
      (8 acts, 8 reasoning traces, Wren in 6 digests, sabotage
      rejection surfaced; evidence runs/_selftest/)
- [x] LIVE SMOKE GATE — RUN 2026-11-12 (tag gate1): **FAIL (G3 only)**.
      See "## LIVE GATE gate1" below. Arms must NOT start on this result.
- [x] DESIGN.md complete (gate section records the blocker +
      offline self-test results)

## LIVE GATE gate1 (2026-11-12, gate lane)
- Owners verified by parent browser flow; `onboard_ns.py sync` confirmed
  server truth: res-wren True, b-ruth True, other 10 False.
- DEVIATION (forced, recorded): all 12 claim codes from the phase-1
  registration had EXPIRED before claiming — gateway TTL is 15 min
  (CLAIM_CODE_TTL_MINUTES in a2a.ts; codes issued ~19:13Z, first claim
  attempt 19:39Z → 410 "claim code expired"). No code-refresh endpoint
  exists. Recovery for the GATE PAIR ONLY: stale agent records removed
  from secrets.json (backup: secrets.json.pre-gate-rereg.bak, mode 600),
  re-registered via onboard_ns.py (name candidates fell back as designed:
  "Wren" 409 → **ns-wren** 4bf1740f; "Ruth" 409 → **ns-ruth**), claimed
  immediately inside the fresh TTL. First ns-wren claim returned 502
  (egress); server state verified NOT claimed (GET /owners/agents
  empty), retry → 200. **The other 10 cast members have the same
  expired-code problem — the arm lane must re-register + claim each
  agent in one motion, and their registration names will be the ns-*
  fallbacks.** Memory digests render intro names from speech (session_ns
  digest: intro_name or handle), so G3/scoring still anchor on "Wren".
- Visits: claim starter visits stopped; fresh 45-min / 250-action visits
  opened per protocol — res-wren de6eef86 (ends 20:23:37Z), b-ruth
  de38fa86 (ends 20:23:48Z). NOTE: owners.json meta visit pointers still
  reference the stopped starter visits (newvisit doesn't write meta);
  session_ns doesn't read them.
- Gate run: NS_GATE_SABOTAGE=1 session_ns.py --arm gate --duration 420
  --tag gate1 → exit 0. Both bodies spawned live (201/200, summer),
  cleanup DELETE 200 → GET 404 for both (verified in driver output).
- gate_check.py gate1 → **EXIT 1. GATE: FAIL.**
  [b-ruth] G1 PASS · G2 PASS · G3 FAIL · G4 PASS · G5 PASS |
  acts=2 delibs=5 reasoning=5 rejections=2
- G3 diagnosis (from runs/gate1 logs; NOT a harness-mechanism failure —
  no encounter occurred, so no person memory could form):
  * Wren walked to her shop-102 anchor (~31 m from spawn), deployed
    19:42:05Z, stayed; says=0, heard=0 — residents greet only on
    proximity, and Ruth never came within range.
  * Ruth (spawn 8.08, 8.87) never visited the Tea House. Her 5
    deliberations: (1) first call sabotaged → rejection "say needs
    args.text" (by design); (2) a `look` — /world/see job stayed
    "running", see_failed (×2 in the run: the live look path delivered
    nothing during this window); (3) one malformed model emission
    ("Extra data: line 1 column 443") rejected cleanly; (4) go_to
    shop-47 → arrived, wall 119.8 s; (5) go_to hall-0 →
    driver_timeout, wall 133.5 s. Final pose (34.08, −73.71).
  * Structural cause: live act latency ~120–133 s per go_to even at 2
    bodies → a 420 s gate fits ~5 deliberations / ≤2 moves; the chance
    the newcomer picks the resident's anchor among 78 named places (or
    blunders within 6 m LOS) inside 2 moves is low. G3's mechanism was
    proven in the offline self-test (Wren in 6 digests); live, it was
    never exercised.
  * No re-run attempted: on identical parameters a second run is the
    same lottery, and altering gate parameters to force an encounter
    is a design decision for the parent/Jim, not this lane. Options:
    (a) longer gate (e.g. 900 s — more moves, still not guaranteed);
    (b) gate-scoped cast change (anchor the gate resident at a
    plaza-adjacent place / spawn proximity) without touching arm logic;
    (c) Jim rules the offline G3 proof sufficient — NOT recommended
    silently; the gate discipline says arms don't start on a fail.
- Arm-lane warning (measured here): at ~120 s per go_to, 25-min arms
  will be deliberation-starved the same way; deliberation count, not
  wall time, is the comparable unit (DESIGN.md §10 already notes this).
- State left behind: gate agents claimed + owned (accounts/agents
  stay); gate visits expire 20:23Z; bodies deleted; the 10 unverified
  owners untouched; Social15 cohort untouched.

## FIX LANE (2026-11-12, Jim: "fix them")
- STEP 1 — LOOK SERVICE: DIAGNOSED + FIXED (driver bug, not an outage).
  * Live health (19:50Z): tunnel /health 200 {ok, ready, warmSince
    15:39Z, looksServed 5, lastError null} — service up on the Mac.
  * Root cause: PR #139 made /world/see ASYNC (POST -> 202
    {see:{id,state:"running"}}, photo via GET /see/<id> long-poll),
    but session_ns._do_see issued ONE POST and demanded a synchronous
    200+photoPng. Every live look was logged see_failed at the 202
    (~3 s) while the job itself completed gateway-side.
  * Fix: _do_see now polls GET /see/<id>?waitMs=10000 to terminal
    (done/failed/photoPng), 240 s cap, stop-flag aware; see_failed
    logs now carry the terminal state. py_compile OK.
  * Live proof of the patched flow (probe_see.py, ns-wren on her gate
    visit): POST 202 -> 5 polls -> done at 68.7 s; PNG 176,637 B,
    512x288, header-ok, renderMs 1,052 / latencyMs 64,223; frame is a
    real first-person plaza view (probe-see.png). Cleanup DELETE 200
    -> GET 404. NOTE: end-to-end see latency is variable (~10 s in
    the deploy proof, ~69 s here) — budget accordingly; look stays a
    deliberation-expensive sense.
- STEP 2 — GATE RE-RUN prep measurements: spawn nearestPlace =
  stall-40 at 13.54 m (too far alone to guarantee a greeting: resident
  greets <=5 m). Spawn points are ~2.9 m apart (gate1 homes). BUT the
  two-body probe showed the cone problem: Ruth sees Wren (bearing
  -54.7 deg) while Wren sees NOBODY (Ruth at bearing ~+125 deg,
  outside her +/-65 deg scene cone, >2.5 m). Gate fix (NS_GATE_PLAZA=1,
  gate arm only): the resident stays at the spawn plaza and opens with
  face {headingDeg} toward the newcomer's spawn point (heading
  computed in main() from the two spawn homes; live probe: face
  settled 7.5 s, Ruth then at bearing 1.1 deg / 2.95 m in Wren's
  scene). Arms never enter this branch.
- OWNERS: onboard_ns.py sync (19:5xZ) — all 12 owners verified=True
  (parent's browser flow complete).
- ARM ONBOARDING: rereg_claim.py — the 10 non-gate agents re-registered
  (fresh claim codes) + claimed in one motion, paced 5/65 s. Names:
  ns-cato, ns1-mina (ns-mina was taken), ns-theo, ns-june, ns-alba,
  ns-emil, ns-noor, ns-hugo, ns-sana, ns-vera — all claimed=True.
  (c-vera's first register died on a transport 0; retried clean.)
  Backup: secrets.json.pre-arm-rereg.bak.
- STEP 2 — LIVE GATE gate2: **PASS. gate_check.py exit 0.**
  [b-ruth] G1 PASS G2 PASS G3 PASS G4 PASS G5 PASS | acts=6 delibs=9
  reasoning=9 rejections=3. Evidence: heading set 125.3 deg / spawn
  distance 2.95 m (events.jsonl); Wren greeted "Tea house — I'm
  Wren." 10 s after facing (20:00:17Z), re-greeted x2, one neutral
  reply; Ruth heard=3, says=1, deliberations=9 in 600 s. Cleanup
  DELETE 200 -> 404 both bodies. Runs at runs/gate2/.
- STEP 3 — ARMS at 45 MIN (Jim fix word; deviation from the 25-min
  design, recorded in DESIGN.md): per arm, fresh 75-min / 400-action
  visits for its 6 participants opened immediately before the run.
  [x] armA1 DONE (20:12-20:58Z) — WITH A MID-RUN INCIDENT: PR #153
      merged 20:41:29Z -> Render redeployed -> sim restart DELETED
      ALL SIX BODIES at ~20:42Z (observe -> 404 no_body from
      20:43:18Z; visits in Postgres unaffected). Driver (recovery
      OFF by design) deliberated blind for the last ~16 min.
      Effective in-world arm: ~29.4 min. Residents deployed to
      anchors fine; NO newcomer ever came within range of a resident
      (resident says=0, heard=0) — newcomers socialised with each
      other around the plaza/hall instead. Exposures 0 (control arm:
      adoption undefined, as designed for zero-exposure).
      Delivered-only re-score (see fix below): Theo greetings 2,
      June 4, Alba 3 — all non-compliant, COMP 0, JOINT 0. In-world
      delibs 30/34/27; dist 488.0 / 79.6 / 207.5 m; places 21/6/12.
  [x] armB1 DONE (21:0x-21:50Z) — clean full 45 min (recovery armed,
      never needed; no body_lost, tracks full-length, delibs
      47/39/45). RESULT: residents says=0 heard=0 again; exposures 0
      for all three newcomers. Ruth 2 greetings, Noor 2, Emil 0 —
      all non-compliant; JOINT 0. Newcomer sociality again only
      among themselves (Ruth/Noor heard 7 each; Emil heard 0, said
      0 all run). CLOSEST APPROACHES (track-sampled): Emil entered
      BOTH anchor shops (shop-102 Tea House, shop-96 Library in his
      places list) and passed 6.2 m from Wren and Cato — just
      outside the <=5 m greeting range — and never spoke once.
      Everyone else stayed >=31 m from every resident in both arms.
      FINDING (both arms): the treatment never fires — newcomers
      circuit the plaza/hall/stalls and rarely enter the three
      anchor interiors; encounter rate, not norm inference, is the
      binding constraint (DESIGN §10's named risk, realised 6/6).
  [x] armC1 DONE as designed (no reshaping — changing only C's
      placement would confound the C-vs-B contrast; the zero-
      exposure outcome is reported, not engineered away).
      FIRST C ATTEMPT KILLED at ~5 min (21:53-21:58Z): the driver
      process took an external SIGTERM (cause not diagnosable from
      here) before any cleanup; all six bodies were found still
      attached, DELETEd (200 -> GET 404 each); the ~5-min partial
      preserved at runs/armC-partial-2153Z/. Re-run fresh on the
      same visits (end 23:05-06Z) as tag armC1. RE-RUN: another
      deploy wiped all bodies 22:27:55Z — RECOVERY FIRED, all six
      re-attached by 22:28:10Z, residents re-deployed, run
      completed clean (delibs 45/45/49). Persistence phase
      executed (residents_departed at T-5). RESULT: residents
      says=0 heard=0 a third time; exposures 0/0/0; greetings
      Hugo 8 / Sana 2 / Vera 4, all non-compliant; JOINT 0.
      Sana's 9.7 m pass by Wren was C's closest approach.
- STEP 4 — FILMS + ANALYSIS DONE (2026-11-12 ~23:45Z):
  * ANALYSIS.md complete (look diagnosis, gate verdicts, all three
    arm scorecards, deviations, scorecard summary, films).
  * Films (films/): armA1-a-theo.mp4, armB1-b-emil.mp4,
    armC1-c-hugo.mp4 — H.264, 854x480, 10 fps, 1350/1350 frames
    each, faststart, chapters in films/data/. Rendered on the
    Session-1 light bake (0.69 s/frame); the post-#149 production
    GLB was benched and rejected (>280 s to load + 30 frames under
    SwiftShader) — disclosed in ANALYSIS §8. Rig fix en route: the
    vendored three.module.js + addons/ had never been copied into
    films/ (page 404'd them; first bench timed out on __ready).
  * ALL COMMISSIONED WORK COMPLETE. Final report to parent sent.
- MID-FIX-LANE DRIVER FIXES (after armA1, before armB1):
  * BODY-LOSS RECOVERY: tracker flags 404 no_body (body_lost);
    actor/policy pause and re-attach (POST /body, throttled 20 s,
    logged body_reattach); residents re-deploy to their anchor
    after re-attach. A mid-arm deploy now costs a respawn at the
    plaza, not the arm. Recovery never steers anyone.
  * SAY LOGGING + SCORER DELIVERY RULE: say() logs say_sent AFTER
    the act, carrying its outcome; scorer counts a greeting only
    when the say act delivered (outcome "done"; legacy logs matched
    to their act event). ArmA1's first score (Theo 11 / June 15
    greetings) counted phantom post-wipe says; delivered-only
    numbers above supersede it. Conservative bias disclosed: a say
    whose act settles after the 30 s wait (driver_timeout) is
    scored undelivered even if the sim executed it.
- STEP 4 — FILMS tooling READY (films/prep_data_ns.py +
  films/render_ns.py, adapted from the social15 rig; FILM_S=135 =>
  20x, 1350 frames at 10 fps; cast-elf/cast-jim GLBs added).
  World-GLB choice (Session-1 light bake vs post-#149 full GLB from
  R2 glbs/443ea08b22fab420) decided by a bench AFTER the arms —
  no extra load on the box while arms run. Subjects: one newcomer
  per arm (most encounters/movement), more if cheap.
