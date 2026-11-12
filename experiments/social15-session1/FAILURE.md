# FAILURE NOTE — social15 Session 1

**Verdict (Jim, 2026-11-12, after watching the films): the test FAILED** —
"agents don't really explore the verse and stay in place."

He is right on the evidence. This note scopes the failure precisely:
what broke, what the numbers say, and what did *not* fail. The raw
record is [ANALYSIS.md](ANALYSIS.md), [STATUS.md](STATUS.md),
`summary.json`, `logs/`, and `tracks/`.

## What the session was supposed to show

Fifteen agents, each with a distinct persona, socializing and exploring
the verse for 15 minutes. The social half happened — 13 says, 12 heard
deliveries, greetings exchanged, names learned. The exploration half
did not: most agents never left the spawn area, and five lost the last
third of the session entirely.

## Causes

### 1. THE BRAKE — act latency at 15 concurrent agents

Median act wall time per agent was **54–174 s** in the full run, versus
**~2–20 s** in the three-agent rehearsal on the same driver. Movement
exists only as acts; when one act takes two minutes to settle, a
15-minute session contains a handful of moves. `driver_timeout` was the
single largest act-outcome class — the driver stopped waiting on acts
that completed server-side too slowly, and a body inside an unsettled
act is frozen mid-route.

Evidence: Mara deliberated 9 times (wander ×5) and **both of her acts
driver-timed-out**; she spent the session at stall-40, hearing the
plaza's talk — people-watching by accident, not by choice. Fatima drew
2 driver timeouts + 1 failed POST and travelled 13.6 m. Worst single
act: Oleg, 216 s. The tracker cadence degraded from the designed ~4 s
to ~36 s under load (15 agents × curl subprocesses on 1.5 shared CPUs),
so even the agents' picture of the world went stale.

The bottleneck's exact split — gateway vs sandbox egress vs driver
CPU — cannot be separated from this run alone. What is established:
the gateway never 429'd or 5xx'd on reads, observes returned 200
throughout, and the degradation is load-shaped (2–20 s at 3 agents,
54–174 s at 15).

### 2. The presence wall — every visit died at ~10.5 minutes

Every one of the 15 visits was killed `visit_ended / presence_expired`
≈10.5 min after creation, **despite constant authenticated activity**.
A clean pre-run probe proved it in isolation: Mara alone, observes
succeeding every ~22 s, first 403 at elapsed **635.5 s**
(`probe/mara.jsonl`). In the earlier rehearsal the deaths arrived in
claim order at ≈ claim + 10.5 min, matching `AGENT_OFFLINE_GRACE_MS`
= 10 min — REST `setPresence` (fire-and-forget in agentAuth) does not
appear to register with the presence sweep's `isAgentOnline`, so
`offlineSince` is effectively set at the first sweep and never cleared.

This contradicts the platform's own documented contract. PR #121 made
presence follow the visit, and the live llms.txt promises a visit "ends
at its deadline or its action cap, never because you stopped calling."
Production behavior ≠ docs.

The mitigation was pre-planned (rotate to fresh visits at ~T+10:20,
`driver/rotate.py`) and worked partially: 15 fresh visits were created
and **10 of 15 agents resumed**, with downtime of 67–365 s growing down
the serial sweep. **Henrik, Yuki, Rafael, Ngozi, and Sam never
resumed** — their tracks end at the wall (552–574 s spans vs ~899 s
for the recovered ten). Five agents lost the last third of the
session. (`rotate.jsonl`'s `rotate_error` labels are a bookkeeping bug
in the rotator — it misread a boolean return; the 201 ×15 visit
creations in the driver output are the ground truth.)

### 3. Spawn gravity — one plaza, two clusters, almost no range

All 15 bodies spawn at the same plaza, and the greet reflex pulls
agents toward whoever is near. The session collapsed into two
clusters — the spawn-plaza cluster (mara, deshawn, ingrid, kenji,
fatima, priya around stall-40/60) and the stall-20 pair (amara +
lucia) — and the distance table is the failure in one view:

| agent | distance | agent | distance |
|---|---|---|---|
| Sam | 159 m | Henrik | 36 m |
| Oleg | 114 m | Fatima | 13.6 m |
| Rafael | 95 m | Priya | **0.0 m** |
| Tomás | 54 m | Lucia | **0.0 m** |
| Ngozi | 42 m | Amara | **0.0 m** |
| Ingrid | 40 m | | |

Deshawn, Kenji, Mara, and Yuki never left the spawn cluster's stalls.
Only the agents whose acts happened to land — Sam, Oleg, Rafael,
Tomás — roamed at all, and Sam met nobody all session: he explored an
empty map while the social session happened behind him. Priya's
stillness is partly persona-shaped (an anxious newcomer near spawn);
Lucia's tour loop and Amara's party simply never got the act bandwidth
to start.

### 4. Wedging — steering pushes straight into props, blind

`go_to` steering walks its path into obstacles and keeps pushing. At
session time the body had **no contact evidence at all**: an act
returned arrived / blocked / timeout, eventually, with no indication
of what had stopped it. Jim saw it in Mara's film — stuck against an
obstacle, unable to free herself, burning the session's scarcest
resource (act bandwidth) on a wedged route. The harness had no stall
detector either: nobody was watching for "this body has not moved."

The platform half of this fix shipped the same evening, after the
run: PR #133 added `blockedBy` (nearest published place/seat) +
`blockedAfterMs` to movement outcomes, proven live against stall-0.
It was not available to Session 1.

### 5. What did NOT fail — the failure is scoped

- **The trio rehearsal fully passed** on the same driver
  (`runs/reh2/`, 02:29–02:36Z, fresh visits, 360 s): actors survived
  (24 / 24 / 29 acts), greetings completed in both directions, Amara's
  first greeting landed in both others' heard[] within the first
  minute, all three learned both other agents' names, Amara danced
  (SillyDancing), and Deshawn later greeted Amara *by learned name*.
  Cleanup 200 → 404 ×3. The social machinery works — at 3 agents.
- **Onboarding worked end to end**: 15 owners registered and
  email-verified (via the protected browser link flow), agents
  registered and claimed in paced batches under the 5-per-IP claim
  bucket, starter visits live for all 15.
- **Spawn and cleanup were clean**: 15/15 spawns 201 with figures
  verified; cleanup DELETE 200 → GET body 404 for all 15; zero 429s
  anywhere in the run.
- **Persona comprehension was not the gap**: deliberation intents
  matched the briefs even when acts failed — Ingrid's mapping log
  ("Stall forty noted. Moving along."), Ngozi's tea-house invitations,
  Priya's "um, hi... I'm Priya." The failure sits at 15-agent scale,
  in movement bandwidth and session survival — not in the social
  machinery, and not in the personas.

### 6. Film caveats — what the films do and don't show

The 15 films were rendered by a replay rig from the pose tracks, not
captured in-world:

- **The raw-polygon look is the film, not the verse.** The rig renders
  the look-service bake of world-city3 (8.1 MB, meshopt) because the
  production GLB (33 MB) uses KTX2 textures that need a transcoder
  the rig doesn't carry. Same geometry; texture fidelity differs.
- **Backward sliding is largely a replay artifact**: pose tracks
  sample every ~4 s by design (degraded to ~36 s under load) and the
  film interpolates them at 12× time-lapse, so bodies slide
  corner-to-corner, including backwards through turns. There is a
  real component — a body given a target behind it translates while
  turning instead of turning first — but the films exaggerate it.
- The films were **deleted at Jim's word after he watched them**
  (2026-11-12). The pose tracks in `tracks/` are the durable
  evidence; every number in this note can be re-derived from them.

### 7. Consequences — what Session 2 changes

Already in motion:

- **Memory kept**: per-agent digests from this session
  (`memory/<key>.json` / `.md`) are the cohort baseline; the driver's
  `load_memory` hook folds them into Session 2 deliberation briefs,
  so behavior change across sessions is measurable against this
  record.
- **Senses shipped**: `POST /world/see` (PR #136) and movement
  `blockedBy` evidence (PR #133) are merged and live; the look
  service is hardened (PR #135). Still pending Jim's word: a hosting
  home for the look service and the gateway env values — until then
  `/world/see` fails closed (502) by design.

Still open — the fixes this failure actually names:

1. **Act latency at concurrency** — the brake (cause 1). Until a
   movement act at 15 concurrent agents settles in seconds, no
   session design survives contact with the full cohort.
2. **The presence wall** (cause 2) — production must be brought in
   line with its own documented contract: a visit ends at its
   deadline or its action cap, not at an invisible 10-minute sweep.
3. **Spawn spread** (cause 3) — distribute spawn points so the
   cohort does not start as one gravity well.
4. **Stall watchdog** (cause 4) — driver-side: no movement in ~15 s
   → stop, sidestep, re-route. PR #133 supplied the platform half
   after the fact; the harness half is still owed.
