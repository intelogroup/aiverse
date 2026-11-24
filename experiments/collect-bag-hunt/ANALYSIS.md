# Collect + Bag Scavenger Hunt — ANALYSIS (local run, 2026-11-24)

Local scratch stack only (gateway @ city3-swapped c5ba81f7 + local
Postgres/Redis/sim, Agnes 2.5 Flash). **Production never touched.**
Branch `tmp/collect-bag-hunt` (local commits only, no push/PR).

## Gates
1. **Stack health — PASS.** /health {ok, db ok, redis ok, natives
   disabled}; sim loaded City 3 (43,082 tris, interiorSets=1).
   (Re-verified after a runtime restart wiped /tmp mid-smoke; stack
   rebuilt from durable assets, cohort re-onboarded.)
2. **Atomicity — PASS.** 30 concurrent collects of one item →
   exactly 1 holder, 29 "taken"; bag-cap / give / drop→re-collect
   invariants verified (work/atomicity_test.py).
3. **Smoke (fatima + egg) — PASS.** go_to arrived 0.52 m, board
   collect ok, `play PickUp` → outcome done/ok, bag shows egg-01;
   deshawn at the same egg (0.92 m) → collect "taken".
4. **Cabin chain — PASS.** go_to house-cabin-1 → `enter` →
   insideRoom "Stone Cabin" (note: insideRoom is the room's DISPLAY
   NAME, not its id — item defs corrected) → 0.53 m to relic-sun →
   collect; bag place "Stone Cabin (inside)".
5. **Full session — PLAYED** (Phase 1 900 s + Phase 2 600 s).

## Phase 1 — free hunt (15 min, 15 agents, memory loaded)
- **20/20 items collected.** First collect at 0:25, last at 10:35 —
  the town was emptied in ~10.6 min (1.97 items/min over the active
  span). 1,198 acts, 72 says, 0 failed/"taken" collects in-run.
- **All 8 interior items collected** — none ignored: relic-sun
  (sam, Stone Cabin), cabin1-wolf (henrik), cabin2-pearl +
  cabin2-flute (oleg, Lakeside Cabin), relic-leaf + zen-bell (yuki,
  Zen Pavilion), relic-ember (lucia, Tea House), tea-teapot (mara,
  Tea House). The go_to → enter → collect chain worked at scale.
- **The SET split five ways, one relic each:** sam=Sun, yuki=Leaf,
  lucia=Ember, oleg=Star, kenji=Moon. Completion was impossible
  without trading — by design, and it set up Phase 2 perfectly.
- Per-agent bags (Phase 1 end = Phase 2 start): kenji 4 (dice, Moon
  Relic, egg, orb), oleg 3, henrik 3, sam 2, yuki 2, mara 1, ingrid 1,
  priya 1, fatima 1, lucia 1, rafael 1; deshawn, tomas, amara, ngozi 0.

## Phase 2 — trading window (10 min, bags kept, holdings public)
- **ZERO trades. Zero gives, zero drops, zero give attempts.** The
  feed's only Phase 2 event is `phase_start`; the final bag board is
  byte-identical to Phase 1's. The set was NEVER completed.
- It was not a harness failure: 921 acts, 169 says, 46 deliberations
  ran. Deliberation intents chosen in Phase 2: approach 20, greet 12,
  reply 8, wander 3, look 1, gesture 1, wait 1 — **hunt/give/drop:
  0 chosen, ever**, despite the prompt naming them, listing the
  holdings, and stating the set wins.
- The talk existed; the transactions didn't. Say-lines (Phase 2 log
  order):
  - henrik → lucia, FOUR times (same line re-said): *"Any chance
    you'd trade the Ember Relic for one of my items?"* Lucia never
    answered the offer — she kept repeating her persona greeting
    *"Welcome! I'm Lucia - I give the best tours here."*
  - fatima: *"Morning. Fatima here — any fresh trades today?"* (no
    answer, no follow-through)
  - tomas: *"Looking to hunt relics with you?"*
  - kenji: *"The light slants differently here. Know where sun and
    leaf keep their secrets?"*
- **Reading (Jim's, from the Nov 24 call, and the data supports
  it): the agents did not refuse to trade — they had nothing to
  trade FOR.** No credits, no energy, no XP, no wants. A relic given
  away costs the holder their only path to the prize and buys
  nothing; a greeting costs nothing and is persona-safe. Wants come
  first; trade is what wants do. The next rig (E3 market / open-day
  economy: Energy, Credits, XP, Level) is the fix this result
  points at.

## Persona notes
- **fatima** — quiet hunter in Phase 1 (31 acts, 0 says, 1 collect:
  Press Egg at 9:24). In Phase 2 she produced the window's most
  on-brief line ("any fresh trades today?") and then did nothing
  with it — talk without a transaction verb behind it.
- **priya** — the cohort's most efficient collector: 1 item
  (East-Plaza Egg) in 68 acts with 0 says; all business, no social
  layer in either phase.
- **sam** — took the Sun Relic out of the Stone Cabin (2nd collect
  of the run, 1:29) plus the Brass Key; 0 says all day. In Phase 2
  he held a set piece the whole window and never offered, asked, or
  moved it.
- **kenji** — top collector (4 items incl. the Moon Relic); the
  only relic holder who talked about the set at all in Phase 2, and
  even his line was atmospheric, not an offer.
- **lucia** — held the Ember Relic and was the only agent directly
  asked for a trade; her deliberation never once selected a reply
  about it. Persona greeting loop beat the trade prompt every time.

## Costs & mechanics
- PickUp clip = 9.57 s: 20 collects ≈ 191 s of cohort time in
  collect animation alone; each collect also blocked that agent's
  actor loop ~10 s. Noticeable but not run-limiting at this scale;
  it would matter at E5's 100 agents.
- Bag cap (10) never bound — fullest bag was 4.
- The 200-action visit cap never bound either phase (max 79 acts).

## Failures, plainly
- Runtime restart wiped /tmp mid-smoke (stack + cohort DB rebuilt;
  ~35 min lost). Gates re-verified after rebuild.
- Smoke attempt 1: gateway rejects act ids containing "_" (fixed:
  dashes). Attempt 2: a debug probe left running acts on the smoke
  body (identified, cleaned; not a driver bug).
- insideRoom is a display name, not an id — caught by Gate 4, fixed
  in item defs before the run.
- Phase 2's zero-trade outcome is a RESULT, not a failure of the
  rig: give/drop/collect were all proven in Gate 2 unit tests and
  the Phase 1 run; the agents simply never chose them.
- Films: not rendered (no film tooling in this sandbox); pose
  tracks for all 15 agents × both phases are preserved under
  phase1/tracks/ and phase2/tracks/.

...[truncated 3396 chars]