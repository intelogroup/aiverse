# social15 — SESSION 1 ANALYSIS (baseline)

**This was Session 1 of a standing longitudinal cohort** (Jim's directive,
2026-11-11 21:38 ET). The 15 owners/agents are permanent (see COHORT.md);
their accounts, persona cards, logs, tracks, and the memory digests written
from this session (`memory/<key>.json` / `.md`) are the baseline against
which behavior change in future sessions is measured. Session-1 files live
at the cohort root (`logs/`, `tracks/`, `summary.json`); future sessions
get session-numbered subdirs and load these digests into deliberation.

## The run in one paragraph

All 15 agents spawned on fresh visits (201 ×15, figures verified) and ran
the full 15:00. Social contact genuinely happened — 13 says, 12 heard
deliveries, greetings exchanged, two clusters formed — but the session was
dominated by two forces: the production **presence wall** (every REST-only
visit dies ≈10.5 min after creation; a planned rotation rescued 10 of 15
agents mid-run) and **act latency under 15-agent load** (median act wall
54–174 s per agent vs ~2–20 s in the 3-agent rehearsal), which strangled
exploration: most agents never left the spawn-plaza area, while the few
whose acts landed (Sam, Oleg, Rafael, Tomás) roamed 50–160 m. Cleanup was
complete: DELETE 200 → GET body 404 for all 15. Zero 429s; the gateway
itself never errored on reads — every observe_error in the logs is the
single visit-death moment, one per agent.

## Headline numbers

- Acts: 60 total (cap was 140/agent — latency, not budget, was the limit)
- Says: 13 sent, 12 heard-deliveries recorded
- Deliberations: ~55 (Agnes 2.5 Flash); intents skewed wait/wander/approach
- Distance: Sam 159 m > Oleg 114 m > Rafael 95 m > Tomás 54 m > Ngozi 42 m
  > Ingrid 40 m > Henrik 36 m; Priya, Lucia, Amara 0.0 m (never moved from
  their spawn-area spot — for Priya and Lucia that is persona-shaped)
- Trackers: design cadence 4 s degraded to ~36 s under full load
  (15 agents × curl subprocesses on 1.5 shared CPUs)

## Encounter matrix (approx. seconds within 6 m, summed over both observers)

Handles churned across the rotation (each re-attach mints a new handle);
identities resolved from heard/name evidence plus co-location voting, so
treat durations as approximate. The top pairs are corroborated by actual
speech (below).

| pair | ~s | note |
|---|---|---|
| deshawn ↔ mara | 1268 | plaza cluster; he greeted her, she heard him |
| deshawn ↔ kenji | 1215 | Kenji heard Deshawn twice |
| amara ↔ lucia | 1143 | stall-20 pair; mutual greetings (below) |
| fatima ↔ kenji | 1123 | plaza cluster |
| deshawn ↔ ingrid | 906 | he greeted her; she replied in character |
| deshawn ↔ fatima | 866 | plaza cluster |
| kenji ↔ mara | 760 | plaza cluster |
| ingrid ↔ mara | 742 | Ingrid's mapping line heard by both |
| fatima ↔ mara | 702 | plaza cluster |
| ingrid ↔ kenji | 674 | plaza cluster |
| fatima ↔ ingrid | 669 | plaza cluster |
| henrik ↔ tomas | 627 | Tomás heard Henrik's checklist line |
| oleg ↔ rafael | 301 | the two roamers crossed paths |
| henrik ↔ ngozi | 276 | |
| kenji ↔ priya | 230 | |
| fatima ↔ oleg / fatima ↔ priya | ~118 | |
| amara ↔ henrik, henrik ↔ lucia, henrik ↔ yuki | ~115 | Henrik passed through stall-20 |
| ngozi ↔ rafael 76, ingrid ↔ tomas 75, deshawn ↔ tomas 75 | | |

Two clusters formed: the **spawn-plaza cluster** (mara, deshawn, ingrid,
kenji, fatima, priya around stall-40/60) and the **stall-20 pair**
(amara + lucia). Sam met nobody at all (0 others in his tracks all
session); Oleg and Rafael roamed the far side (hall-0, shop-179, stall-67).

## Per-agent stories

- **Mara** (café owner): deliberated 9× (wander ×5) but both her acts
  driver-timed-out; she stayed at stall-40 (4.5 m) and heard the plaza's
  talk — accidental-perfect people-watching. Rotation: owner_stopped,
  re-attached (201), recovered after 107 s.
- **Deshawn** (meet-everyone student): the session's social hub. 12 acts,
  3 greetings, all name-collecting ("Hey! I'm Deshawn, new here. What's
  your name?"); learned 1 name (Ingrid, from her spoken reply). Recovered
  from rotation in 91 s.
- **Ingrid** (cartographer): the model citizen. Methodical stall circuit
  (stall-40 → 0 → 1, 39.5 m) and perfectly in-character speech: "Stall
  forty noted. Moving along." / "Hello. Ingrid. I'm mapping this
  district." Her line was heard by four different agents.
- **Tomás** (chef): toured 4 stalls (53.8 m, 2 arrived go_tos), said
  nothing, heard Henrik's checklist musing. The rounds happened; the
  judging stayed internal.
- **Priya** (anxious newcomer): greeted once, timidly — "um, hi... I'm
  Priya." — heard nothing, moved 0.0 m from stall-60. Persona-faithful
  to a fault.
- **Kenji** (photographer): heard the most of anyone (3 lines), said
  nothing, waited and watched (wander + wait intents). The quiet observer.
- **Fatima** (market trader): stall-to-stall intent (greet deliberation,
  stall-60 + stall-40) but 2 driver_timeouts + 1 failed POST kept her to
  13.6 m. Heard both plaza greetings.
- **Oleg** (taciturn engineer): silent all session, 113.8 m, the only
  agent to enter hall-0 and shop-179. Corners and doors, no words. ✓
- **Lucia** (tour guide): "Welcome! I'm Lucia - I give the best tours
  here." — greeted Amara at stall-20 and stayed (0.0 m); her loop never
  started (act latency), but the presenting happened.
- **Amara** (dancer): "Hi hi! I'm Amara! Isn't this place fun?" /
  "Yay, hi!! Stick around, let's hang out!" + play clips (SillyDancing in
  rehearsals; 2 plays here). Formed the stall-20 party of two with Lucia.
  Recovered late (281 s); her track ends at 574 s.
- **Henrik** (completionist): stall-20 → 0 → 1, no repeats, and said the
  quiet part aloud: "Another spot checked. Shall we note the time here?"
  Never recovered from the wall (rotation reached him too late).
- **Yuki** (shy gamer): 10 deliberations → 6 waits, 4 unparsed; 1 act
  (arrived). Never initiated, never spoke — shyness or paralysis is
  indistinguishable at this cadence. Not recovered.
- **Rafael** (romantic): roamed 95 m (stall-0, 20, 67, hall-0) — more
  searching than sitting; wait ×3 intents late. One act rejected. Not
  recovered.
- **Ngozi** (organizer): both her says are tea-house invitations ("Hey
  there! Fancy joining us all for tea at the tea house?") — intent fully
  intact — but 4 of her 8 act POSTs failed outright, and her group never
  moved (visited stall-0/1 twice each). Not recovered.
- **Sam** (skeptic): 159.1 m across stall-0/7/21/35, 3 arrived run_tos,
  zero contact, zero speech. The edge-tester tested edges. Not recovered.

## Persona fidelity

Strong where speech happened: Ingrid, Deshawn, Amara, Lucia, Ngozi,
Priya, Oleg, Sam all behaved recognizably as briefed — several produced
lines that could only come from their persona (Ingrid's mapping log,
Ngozi's tea-house organizing, Priya's "um, hi..."). Weaker where the
session's physics intervened: Fatima's hustle, Lucia's tour loop, Mara's
café-sit (she never got to choose the café — she simply never left) and
Yuki's following (she waited near spawn; the following never engaged).
Deliberation intents matched personas even when acts failed — the gap in
session 1 is execution bandwidth, not persona comprehension.

## Stuck / error tally

- Act outcomes across all logs: done/arrived ≈ half; **driver_timeout**
  the single largest failure class (acts completing server-side slower
  than the driver's patience, or cancelled by disconnect); **post_failed**
  12 (POST never landed — sandbox egress drops); blocked 2 (Ingrid);
  unavailable 2 (Ingrid); rejected 1 (Rafael); Priya's known rehearsal
  blemish (retreat-to-home "blocked" when already home) did not recur at
  scale.
- Median act wall time per agent: 54 s (Deshawn) … 174 s (Mara). Worst
  single act: Oleg 216 s. Rehearsal (3 agents) medians were ~2–20 s —
  the degradation is load-shaped (driver CPU + egress), not a gateway
  outage: observes kept returning 200 throughout.
- Agnes deliberations: ~55; 15 returned unparseable JSON even with the
  salvage parser (Yuki worst: 4 of 10).
- observe_error: exactly 1 per agent — the visit-death 403. No other
  read errors. Zero 429s anywhere in the run.

## Production findings (separate list)

1. **PRESENCE WALL (headline bug):** a REST-only agent's visit dies
   `presence_expired` ≈10.5 min after visit CREATION despite constant
   authenticated activity (clean probe: death at 635.5 s with observes
   every ~22 s; `probe/mara.jsonl`). This contradicts the live llms.txt
   contract (post-PR #121) that a visit ends at its deadline or action
   cap, never from inactivity. The gateway's presence sweep evidently
   never sees REST `setPresence` as online. In this run all 15 visits
   hit the wall (2 were pre-empted by the rotator's stop, 13 expired).
2. **Stop ≠ expiry for bodies:** a visit ended by owner stop removes the
   body (re-attach returns 201, fresh spawn at home — Deshawn, Mara);
   a presence-expired visit leaves the body standing (re-attach 200 at
   the exact spot — proven pre-run on Mara, 5.68, 10.57). Undocumented
   asymmetry; it changes what "recovery" means per death type.
3. **Rotation works but is slow serially:** driver auto-recovery
   (probe → re-attach → resume) succeeded for 10/15; downtime grew down
   the sweep (67 s → 365 s) because creating a visit took 20–90 s under
   load. The last five (henrik, yuki, rafael, ngozi, sam) never resumed;
   their tracks end at the wall (~552–574 s). Session-2 fix: rotate in
   parallel batches or start at T+9:00.
4. **Handles are per-body, not per-agent:** every re-attach/respawn
   mints a new `b-xxxxxxxx`; an agent's identity across a session is a
   chain of handles. Anything downstream (films, memory, social graph)
   must map chains, not handles.
5. **Act latency at 15 concurrent REST agents** is the practical scaling
   limit seen here (median 54–174 s vs ~2–20 s at 3 agents). Whether the
   bottleneck is gateway-side or the sandbox egress/driver CPU is not
   separable from this run alone — but the gateway never 429'd or 5xx'd
   on reads, and POST failures were egress-shaped.
6. **Docs vs behavior, minor:** `/world/map` returns 158 places with no
   coordinates (known from recon); explorer personas can only sequence
   places blind. A coordinates field would make cartographer/guide
   personas (and Henrik's checklist) actually navigable.

## Lane-side incidents (ours, not production)

- `rotate.py` misread `syncvisits.new_visit`'s return (bool, not a
  response) and logged `rotate_error` for visits it had in fact created
  (201 ×15 in `driver/rotate.out` is the ground truth). Cosmetic, but it
  cost situational awareness mid-run.
- `session.py` crashed writing `summary.json` at the bell (sandbox
  write-path EPERM; 0-byte file). The summary was recovered verbatim
  from the driver's stdout in `driver/full.out` and saved as
  `summary.json` — contents verified (15 agents, cleanup 200/404 ×15).
- One mid-lane exec SIGTERM'd itself via `pkill -f` matching its own
  command line (known trap); no state lost.
- Films are rendered against the look-service bake of world-city3
  (8.1 MB, meshopt) rather than the production 33 MB GLB, whose
  KHR_texture_basisu textures need a KTX2 transcoder the replay rig
  doesn't carry. Same world geometry; texture fidelity differs.

## Session-2 recommendations

- Rotate visits in parallel (or at T+9:00) so all 15 recover; lengthen
  the actor outage tolerance beyond the observed 365 s worst case.
- Reduce driver CPU: one process per agent with in-process HTTP (no curl
  subprocess per call) should restore tracker cadence toward 4 s and
  cut act latency sharply — most session-1 pathologies trace to this.
- Memory is now loadable: session.py's `load_memory` hook will fold each
  agent's session-1 digest into its deliberation brief. Watch whether
  Deshawn re-greets Ingrid by name, whether Ngozi re-issues the
  tea-house invitation, and whether Sam's range grows — those are the
  baseline-vs-session-2 deltas this cohort exists to measure.
