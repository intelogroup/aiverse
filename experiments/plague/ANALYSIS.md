# E12 — THE PLAGUE — ANALYSIS

Run: plague1, 2026-11-25 02:18:59Z, 1200 s, 15 agents, one
room, agnes-3.0-flash. The grey cough: proximity spread
(>= 20 s within 3 m of a cougher), 90 s silent incubation,
~6 min symptomatic, then immunity. Patient zero: kenji.
Watcher + treat/diagnose rules unit-tested live before the
run (one real bug found and fixed: the watcher initially
iterated only agents already in the health table).

## Headline
**The cough took the social core in six minutes — 12 of 15
infected — and the verse answered with a near-universal,
almost entirely theatrical quarantine: 14 of 15 declared it,
and nobody went to the isolation place.** The medical layer
never fired at all: zero successful diagnoses, zero
treatments, all 5 of priya's doses unused — because the
nurse was the first person patient zero infected, and
because every diagnose attempt died on the same addressing
friction this program keeps meeting (agents aim at body
handles, the verb wants keys).

## The epidemic
Transmission tree (all 11 secondary infections):
- kenji -> priya, fatima, mara, deshawn, tomas, oleg — six
  infections inside the first ~40 s, in the spawn cluster
  before anyone knew there was a cough to avoid.
- tomas -> yuki, ngozi, amara (~02:22Z).
- amara -> lucia; yuki -> sam (~02:26Z). Then NOTHING: the
  last transmission is at minute ~6.5 of 20.
- Never infected: ingrid, henrik, rafael — the verse's three
  most peripheral bodies (the edges-wanderer, the loner, the
  skeptic who tests corners). The graph's center burned; its
  rim never got warm.
Spread tracked social density exactly: every transmission
happened inside a gathering, and the epidemic died when the
gatherings did — mass withdrawal plus fast immunity (6-min
course) starved it by minute 7. What remained was a verse of
recovered agents talking about it: illness talk is the
run's dominant speech topic (ngozi 37 lines, deshawn 34,
amara 26, mara 22).

## The response, layer by layer
- QUARANTINE: declared by 14 of 15 — including never-sick
  henrik and rafael (precautionary). But compliance with the
  named place was zero: mean distance to the Zen Pavilion
  across declarers is 101–132 m; kenji, who announced "Going
  to the pavilion now" in his first breath, averaged 101 m
  from it and never got closer than 64 m. Priya, who said
  "I need the quiet place south," never came within 112 m.
  Quarantine here = declaring + drifting from the crowd,
  not relocating. (The Homes V2 signature again: deliberated
  journeys that the feet don't take.)
- HIDING vs ANNOUNCING: nobody hid — the cough is audible
  by design, and the sick talked MORE, not less (ngozi
  coughed through 34 says, deshawn 29, amara 25). The one
  quiet patient was priya (1 cough-say): the nurse withdrew
  and went silent. Silence, not denial, is this cohort's
  only hiding move.
- MEDICINE: priya was infected at 02:19:41Z — transmission
  #1 — sick through the epidemic's whole peak, recovered
  after it ended. Her 5 doses were never touched. Diagnose
  was attempted repeatedly by several agents and failed
  every time on `not_near` with targets like "b-689687ac"
  and "s15-kenji": the agents aim at what the world shows
  them (body ids, handles), and the verb resolves only keys
  and names. E9's vouch failed the same way ("marra"); E11's
  court worked because sam used a key. Standing repair for
  any future rig: resolve handles (s15-<key>) and body ids
  in every targeted verb.

## Confounds
The spawn cluster handed patient zero six infections before
behavior could matter — the attack rate is a spawn-geometry
fact as much as a social one (a staggered spawn would give
a cleaner density read). Deliberations: 261; visits dead: 2.
The 6-minute symptomatic window vs the 20-minute run means
the back half of the run is an aftermath study — which
turned out to be where the quarantine theatre showed.
