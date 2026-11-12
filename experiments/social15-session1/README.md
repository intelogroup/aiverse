# social15 — Session 1 experiment record

**What this is:** the full record of the first session of the social15
cohort — 15 simulated owners, 15 persona-driven agents, one 15-minute
visit to the verse — including the failure note. Jim's verdict on the
session (2026-11-12): **FAILED**. See [FAILURE.md](FAILURE.md) for why,
with the evidence.

## The commission

Jim, 2026-11-11 20:11–20:16 ET: onboard 15 agents to the verse with a
15-minute visit; tell them to socialize and explore; collect their logs
and film each one so he can watch them. At 20:12 the design became 15
*different owners* with different personas ("Simulate 15 different owner
with different persona"). At 21:38 the cohort was made permanent: "We
will save and keep these users so we see how the agents bear memory from
previous verse interaction and how they behavior change with time in the
verse." Session 1 is the baseline for that longitudinal panel
([COHORT.md](COHORT.md)).

## Design

- **Owners**: 15 accounts, `jimkalinov+<key>@gmail.com`, each registered,
  email-verified, and claiming exactly one agent.
- **Agents / personas**: 15 distinct persona briefs — café owner,
  meet-everyone student, retired cartographer, chef, anxious newcomer,
  photographer, market trader, taciturn engineer, tour guide, dancer,
  completionist, shy gamer, romantic, community organizer, skeptic.
  Roster, handles, and bodies in [COHORT.md](COHORT.md).
- **Harness**: `driver/session.py`. Per agent: a tracker thread (observe
  loop, design cadence ~4 s → `tracks/<key>.jsonl`, heard intake) and an
  actor thread (code reflex policies + deliberation). All verse contact
  goes through the public agent API — the same surface any outside agent
  uses.
- **Brain**: Agnes 2.5 Flash for deliberation (the standing brain for
  verse test agents), called ~every 50 s per agent under a global
  limiter (~18/min; free-tier ceiling ~20 RPM), choosing intents from a
  closed set and composing all speech freely. Between deliberations,
  behavior is code.
- **Autonomy regime**: bounded — mission command. The harness sets the
  senses, cadence, intent vocabulary, reflexes, and budgets; the model
  chooses targets, sequencing, and every word spoken.
- **Session shape**: 15 minutes enforced by the driver (the run's visits
  were 30-minute; the bell is ours). At the bell: DELETE every body and
  verify 404s. Accounts and agents are never deleted — bodies only.
- **Filming**: pose tracks replayed after the run by a three.js rig —
  independent third-person follow-cam, 75 s at 12× time-lapse, 10 fps
  verified by frame count, H.264 MP4. The films were delivered, watched,
  and **deleted at Jim's word**; the tracks are the durable record
  (FAILURE.md §6 covers what the films do and don't show).

## What was run

All times 2026-11-11/12; the running detail is in [STATUS.md](STATUS.md).

1. **Onboarding** (20:24 ET → 02:35Z): 15 owners registered; email
   verification via the protected browser link flow (the Gmail CLI
   redacts verify links by design, so no script ever sees the token);
   agents registered and claimed in paced batches of ≤5 (claim rate
   bucket: 5 per IP).
2. **Rehearsals** (trio: deshawn, priya, amara):
   - Round 1 on `rehearse.py` (~20:53 ET): plumbing pass, social fail —
     three driver bugs (deliberation crash, startup race, outcome
     misread). Evidence in `round1/`, facts in STATUS.md (the round's
     per-agent logs were lost to an archiving slip, owned there).
   - Round 2 on `rehearse.py` (01:48–01:52Z): actors survived, but the
     greet loop never completed and the **presence wall** was
     discovered. Evidence in `round2/`.
   - Round 2 on the rewritten `session.py` (02:29–02:36Z, `runs/reh2/`):
     **FULL PASS** — greetings in both directions, all three agents
     learned both others' names, Amara danced, Amara's first greeting
     landed in both others' heard[] within the first minute, Deshawn
     later greeted Amara by learned name.
3. **Presence probe** (02:26–02:37Z, `probe/mara.jsonl`): one agent
   alone, observes succeeding every ~22 s — the visit died at elapsed
   635.5 s anyway. Wall confirmed in isolation; rotation recovery
   (fresh visit → body re-attach → resume) proven on the same agent.
4. **Full run** (02:42–03:01Z): 15 fresh visits created <60 s before
   spawn, `session.py --duration 900` for all 15 keys, planned visit
   rotation at T+620 s (`driver/rotate.py`, log in `rotate.jsonl`).
   The full 15:00 ran; cleanup DELETE 200 → GET body 404 ×15.

## Headline results

- **60 acts, 13 says, 12 heard, ~55 deliberations** across 15 agents
  (act budget was 200/agent — latency, not budget, was the limit).
- Social contact was real: greetings exchanged, Deshawn collected
  names, Ingrid's mapping line was heard by four different agents,
  Ngozi issued tea-house invitations, Amara + Lucia formed the
  stall-20 pair.
- **Two clusters and almost no range.** Distances travelled: Sam
  159 m, Oleg 114 m, Rafael 95 m, Tomás 54 m — then Ngozi 42 m,
  Ingrid 40 m, Henrik 36 m, Fatima 13.6 m, and Priya / Lucia / Amara
  **0.0 m**. Deshawn, Kenji, Mara, and Yuki never left the spawn
  cluster's stalls.
- **The presence wall hit all 15 visits** at ~10.5 min after creation;
  rotation recovered 10 of 15; henrik, yuki, rafael, ngozi, and sam
  never resumed.
- **Median act latency 54–174 s per agent** under 15-agent load
  (trio rehearsal: ~2–20 s).
- Full analysis in [ANALYSIS.md](ANALYSIS.md): encounter matrix,
  per-agent stories, persona fidelity, error tally, six production
  findings, session-2 recommendations.

## Files

| path | what it is |
|---|---|
| `FAILURE.md` | the failure note — verdict, causes, evidence, what is already fixed |
| `ANALYSIS.md` | the lane's full session analysis (verbatim copy) |
| `STATUS.md` | the lane's running log, recon → films (verbatim copy) |
| `COHORT.md` | the permanent cohort roster and standing orders (verbatim copy) |
| `summary.json` | full-run per-agent counters (recovered verbatim from driver stdout — see ANALYSIS.md) |
| `rotate.jsonl` | rotation log (its `rotate_error` labels are a known bookkeeping bug — see ANALYSIS.md) |
| `logs/` | per-agent event logs, full run |
| `tracks/` | per-agent pose tracks, full run — the film source and the durable evidence |
| `memory/` | per-agent Session 1 memory digests (`.json` + `.md`) — loaded into Session 2 deliberation briefs |
| `driver/` | `session.py` (the harness), `rehearse.py`, `onboard.py`, `rotate.py`, `probe.py` |
| `round1/`, `round2/` | rehearsal evidence on the earlier driver |
| `runs/reh2/` | the passing trio rehearsal on `session.py` (summary + logs + tracks) |
| `probe/` | the clean presence-wall probe (`mara.jsonl`) |

**Not in this record:** `secrets.json` (owner passwords and agent
tokens — never published), `owners.json` (agent/visit identifiers —
not part of the experiment record), and the films (deleted at Jim's
word after viewing).
