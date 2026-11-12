# social15 — 15-owner social test (commissioned by Jim 2026-11-11 20:16 ET)

## Surface recon (20:20 ET)
- Gateway /health ok (db ok, redis ok, natives stale — standing observation). /version gitSha **4d0407f9** (main moved since the verse-fix program).
- llms.txt re-read: pickable bodies = remy, summer, barbarian, knight, cipher, eve.
- **SURFACE CHANGE vs brief: a `say` act EXISTS** ({text ≤140, to?: handle}, heard ≤6 m LOS; observe.heard[] {seq, from, name, text, toYou}). Socializing can include real speech. Also go_to/face accept {body: handle}; scene body entries carry bearing/distance/posture/doing/facingYou/moving (no position — film tracks estimate others' positions from own pose + bearing + distance).
- POST /world/look exists (counts as action; not needed for this run).
- Starter visit on claim = 120 min / 200 actions. Presence follows the visit (PR #121) — no keepalive leash needed for a 15-min session.
- Verify-email is single-use (GETDEL): a lost success response looks like failure — always confirm via GET /owners/me before retrying (loadtest lesson).
- Claim bucket: 5 per IP per ~60 s window — pace claims in sub-batches of 5.
- Agnes: apihub.agnes-ai.com/v1, model agnes-2.5-flash, via custom.agnes-ai surrogate (dynamic_credentials helper). Free-tier effective ~20 RPM → global deliberation limiter ~18/min.

## Plan
- [ ] Tooling check (ffmpeg/chromium/playwright) for films
- [ ] onboard.py: 15 owners (register → Gmail verify → agent register → claim), paced; secrets.json mode 600
- [ ] Smoke: owner #1 (Mara) end-to-end incl. spawn + go_to + delete
- [ ] driver.py: observe loop ~4 s, tracks, Agnes deliberation ~45-60 s staggered + triggers, reflex intent executor, per-agent jsonl logs
- [ ] Rehearsal: deshawn + priya + amara, ~3 min
- [ ] FULL RUN: 15 agents × 15 min
- [ ] Cleanup: DELETE all bodies, verify 404s
- [ ] Films: 15 follow-cam MP4s from pose tracks (three.js replay, time-lapse 3×, ≥10 fps verified)
- [ ] ANALYSIS.md + report

## Log
- 20:20 ET recon done (above).
- 20:24 ET Mara owner registered (201). Verify email arrived (subject "Verify your AIVerse email", from noreply@damhall.com).
- **BLOCKER FOUND 20:35 ET — email verification cannot be completed via the Gmail CLI:** the gws wrapper redacts the verification link in every output path (messages get full/raw, +read, +read's saved .md) to a `[credential:<uuid>]` handle. The raw token never reaches any script. Claim is hard-gated: POST /owners/agents/claim for an unverified owner → **403 email_not_verified** (verified empirically with Mara). The sanctioned channel for the link is the browser-task credential-reference flow → **parent must run 15 browser verifications** (one per owner; each link expires in 24 h; a fresh reference must be read from the owner's email at browse time — references are per-read, two reads of Mara's email gave different UUIDs).
- 20:40 ET all 15 owners registered (201 each); all 15 verify emails confirmed in inbox (1 per alias).
- Mara's agent s15-mara is registered but its claimCode has a 15-min TTL (agent-card) and is STALE — after verification, delete `agents.mara` from secrets.json (or expect name-taken suffix flow) and re-register before claiming. For the other 14, register agents only AFTER their owner is verified (code TTL).
- Post-verification resume path: `onboard.py agent <key>` per owner (claims paced in batches of ≤5 via `agents-batch`), then smoke/rehearsal/full run per plan. Driver + films not yet built — build on resume.
- **RESUMED 20:41 ET (successor lane):** trio verified server-side via GET /owners/me (emailVerified=True for deshawn, priya, amara; local `verified` flags in secrets.json synced to server truth — browser flow had verified them, the local flag was stale). Then `onboard.py agent <key>`: register 201 + **claim 200** for all three, starter visits live (120 min / 200 actions, end ~03:40Z). Gate CLEAR.
- Rehearsal driver built: `driver/rehearse.py` — per agent a tracker thread (observe ~4 s → `tracks/<key>.jsonl` pose tracks incl. raw scene + estimated positions; heard intake) + actor thread (reflex persona policy + Agnes 2.5 Flash deliberation ~50 s, global pace ~1/4 s, closed intent set). Bodies: deshawn=remy, priya=eve, amara=eve (onboard picks). Reuses proven behavior-50 curl client. Budget guard 60 acts/agent; say acts paced ≥2 s.
- **REHEARSAL ROUND 1 (~3 min) — plumbing PASS, social FAIL, 3 bugs found+fixed:** all spawns 201 (figures verified via GET /body: deshawn=remy, priya=eve, amara=eve), trackers recorded 27 pose lines/agent, cleanup clean (DELETE 200 → GET /body 404 ×3), zero 429s. BUT: (1) **BUG (mine)** — Agnes prompt referenced `bb['posture']` (bb has pose.posture) → KeyError killed ALL 3 actor threads at first deliberation; each agent managed only 1 act (wanders). (2) Startup race — actors acted on an empty blackboard before the first observe landed, so Deshawn wandered off before ever seeing Priya/Amara ~3 m away (cone/LOS then hid them). (3) Act outcome ambiguity — client surfaces "settled"; real status word lives inside the act record. Fixes in rehearse.py: posture path, actor/tracker try/except armor, blackboard primed from the spawn observe + actor settle gate, true-outcome extraction from the record, faster cleanup. Round-1 evidence in `round1/` (tracks + summary; note: round-1 per-agent log .jsonl files were overwritten by same-named track files during archiving — facts extracted before the loss are in this STATUS; the slip was the lane's).

## Successor lane 2 — 21:21 ET (2026-11-11)
- Prior lane DID run round 2 (01:48–01:52Z, files in round2/) + a round-3 spawn attempt (all 403) but never recorded them here. Round-2 forensics:
  - Actors SURVIVED (KeyError fix held): deliberations 2–3/agent, acts 2/10/11. Plumbing fine until 01:51Z.
  - **Social FAIL root cause A — outcome extraction:** client act() returns outcome "settled" (record's outcome is a DICT {ok,status,detail}); greet_sequence's success test never saw "arrived" → Priya/Amara looped go_to{body} 10–11×, never reached face/say/play. Says 0, heard 0.
  - **Social FAIL root cause B — Agnes truncation:** several deliberations returned JSON cut mid-string (max-tokens 220) → intent null (Priya ×2). One raw was banner-only.
  - **PRESENCE WALL (production finding):** all 3 visits ended `visit_ended/presence_expired` — Deshawn's observes 403 from 01:51:03Z, Priya/Amara DELETEs 403 at cleanup 01:52:08/15Z. Visits claimed 01:40:26–41Z → death ≈ claim +10.5 min, IN CLAIM ORDER, despite trackers observing every ~9 s. Matches AGENT_OFFLINE_GRACE_MS=10 min with offlineSince effectively set at first sweep and never cleared — i.e. REST setPresence (fire-and-forget in agentAuth) does not appear to register with the sweep's isAgentOnline in prod. Live llms.txt (post-PR#121) promises the opposite ("a visit ends at its deadline or its action cap, never because you stopped calling") — docs ≠ behavior. Round 1 survived only because it fit inside ~10 min of claim.
  - Deshawn also wandered 45 m+ from the spawn cluster before his first successful deliberation (reflex wander on empty blackboard) — scan/settle fix needed.
- Plan (this lane): sync verified flags from server → mara re-onboard (drop stale agents.mara) + immediate-spawn presence probe (~18 min) → trio fresh visits + rehearsal round 2 on a NEW generalized driver (session.py: fixed outcome extraction via record.act.outcome.status + distance-verified greet, Agnes 500 tokens + salvage parse, greet cooldowns, scan-before-wander) → onboard remaining 11 (batches ≤5) → full run on FRESH owner visits for all 15 created <60 s before spawn → films → ANALYSIS.md.

## Successor lane 3 — 21:38 ET onward (2026-11-11)

- **Onboarding COMPLETE:** all 15 agents claimed (trio 20:41 ET; mara re-registered as s15-marab after dropping the stale pre-registration; remaining 11 claimed in paced batches 02:30–02:35Z). Bodies in COHORT.md / onboard.py BY_KEY.
- **REHEARSAL ROUND 2 on session.py — FULL PASS (02:29–02:36Z, tag runs/reh2):** fresh 30-min visits, 360 s session. All criteria: actors survived (visit_dead false ×3), cleanup DELETE 200 → 404 ×3, tracks 35 lines each continuous. Deshawn: 24 acts, 9 says, 13 heard, 6 deliberations, 3 greets, learned both names. Priya: 24 acts, 4 says, 17 heard, 6 deliberations, learned both names. Amara: 29 acts, 10 says, 12 heard, 4 deliberations, 3 greets incl. SillyDancing, learned both names. Amara's greeting landed in both others' heard[] within the first minute; Deshawn later greeted Amara BY LEARNED NAME. Summary: `runs/reh2/summary.json`. Blemish: Priya's retreat-to-home go_to returns "blocked" when already home (act waste; for ANALYSIS).
- **PRESENCE WALL CONFIRMED by clean probe (02:26:19–02:37:02Z):** Mara alone, observes every ~22 s all succeeding; first 403 visit_ended at elapsed 635.5 s — exactly the predicted wall despite constant authenticated activity. Probe log: `probe/mara.jsonl`. (An exec in this lane was then SIGTERM'd by its own `pkill -f` matching its command line — probe died with it after answering its question; no state lost.)
- **ROTATION RECOVERY PROOF — PASS (~02:42Z):** Mara post-death: new visit 201 → POST /body 200 (same body re-attached at 5.68, 10.57, figure summer — bodies persist across visit death) → observe 200 → DELETE 200 → GET 404. Full-run mitigation = planned-death rotation at ~T+10:20 (driver/rotate.py); drivers auto-recover.
- **COHORT DIRECTIVE (Jim, 21:38 ET) FOLDED IN:** the 15 are a PERMANENT longitudinal cohort — see COHORT.md. Cleanup = bodies only; accounts/agents/personas/secrets stay. Today = SESSION 1 baseline. Post-run: memory digests `memory/<key>.json` + `.md` (met/heard/said/places/episode). session.py now loads digests into deliberation context (load_memory hook; inert for session 1). Session-1 files at cohort root (logs/, tracks/); future sessions get session-numbered subdirs.
- **FULL RUN launching (~02:48Z):** fresh 30-min visits ×15 (creation order = spawn order) → session.py --tag . --duration 900 (all 15 keys) + rotate.py at T+620 s. Evidence: logs/, tracks/, summary.json, rotate.jsonl at cohort root.

## FULL RUN — SESSION 1 COMPLETE (2026-11-12 02:42–03:01Z)

- All 15 spawned on fresh visits (201 ×15, figures verified); full 15:00
  ran. Totals: 60 acts, 13 says, 12 heard, ~55 deliberations. Cleanup
  DELETE 200 → 404 ×15 (summary.json recovered from driver stdout after
  the sandbox EPERM killed the file write — see ANALYSIS).
- Presence wall hit all 15 visits (~10.5 min). Rotation created 15 fresh
  visits (201 ×15, ground truth in driver/rotate.out; rotate.py's own
  rotate_error labels are a bookkeeping bug — it misread new_visit's
  bool return). Recovery: 10/15 resumed (downtime 67–365 s growing down
  the serial sweep); henrik, yuki, rafael, ngozi, sam never resumed —
  their tracks end at the wall (552–574 s spans vs ~899 s for the rest).
- Body semantics found: owner-stop REMOVES the body (re-attach 201,
  fresh spawn); presence-expiry PRESERVES it (re-attach 200 in place).
- Act latency under 15-agent load: median 54–174 s/agent (reh2: ~2–20 s);
  driver_timeout the top failure class; 12 post_failed (egress). Zero
  429s; observes 200 throughout except the single death 403 per agent.
- ANALYSIS.md written (encounter matrix, per-agent stories, fidelity,
  error tally, 6 production findings, session-2 recommendations).
- Memory digests written for all 15: memory/<key>.json + .md (session 1
  baseline; session.py load_memory hook consumes them next session).
- FILMS IN PROGRESS: three.js replay rig in films/ (follow-cam, 854×480,
  10 fps, 75 s at 12× from tracks; world = look-service city3 bake —
  production GLB needs a KTX2 transcoder the rig lacks). Benchmark
  0.70 s/frame → ~9 min/agent. render.py all running since ~03:13Z,
  checkpointed (skips verified mp4s); results land in films/*.mp4 +
  data/<key>.chapters.json; verdicts in films/film-results.json.

## FILMS — COMPLETE (2026-11-12 ~05:35Z)

All 15 rendered and ffprobe-verified (films/film-results.json): H.264,
854×480, 10 fps, exactly 750 frames = 75.0 s each, +faststart. Films at
`films/<key>.mp4` (2.7–9.7 MB each); per-film chapters in
`films/data/<key>.chapters.json`. Third-person follow-cam throughout;
other agents shown as colored capsules at bearing/distance-estimated
positions (tracks carry no absolute positions for others; `est` was null
in all 500 track entries — positions computed in prep from own pose +
bearingDeg + heading-in-radians). One runtime restart killed the first
render at 3/15; relaunch resumed cleanly via the skip-verified rule.
Spot-checked frames: Deshawn (plaza cluster, hero readable), Sam at
stall-21 alone (matches his track). SESSION 1 FULLY DELIVERED: run +
cleanup + films + ANALYSIS.md + memory digests + COHORT.md.
