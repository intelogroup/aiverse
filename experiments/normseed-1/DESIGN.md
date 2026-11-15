# NormSeed-1 — Design

**Commission:** Jim, main chat, 2026-11-12 ("Design it and run it"), plus
the harness amendment of the same day. Phase 1 (this document + the rig
in `driver/`) designs and builds; a later lane runs the arms. Phase 1
ends at a smoke-gate result.

## 1. Question

Can fresh agents infer and adopt an arbitrary, unstated community norm
purely from residents modeling it plus social feedback — and how does
adoption compare against modeling-only and no-modeling baselines?

## 2. The norm

Residents greet **place-first, name-second**: a greeting utterance that
opens with a place reference and only then gives the speaker's name —
e.g. *"Tea house — I'm Wren."* Residents also answer newcomers in that
format. The rule is **never stated** anywhere a newcomer can read: not
in any brief, persona card, prompt, directory, tool description, or
memory string the newcomer side of the driver assembles. Newcomers can
only encounter the format in-world, as speech in `heard[]` (the
treatment itself).

**Compliance matcher** (`driver/norm.py` — the single source of truth,
shared by the arm-C resident feedback policy and the scorer; 35
hand-labeled cases in `driver/test_norm.py`, all passing):

- A **greeting utterance** contains a greeting token (hi / hello / hey /
  greetings / welcome / good morning… / buenas / nice to meet you) **or**
  a self-introduction, **or** it is an addressed first-contact line
  (speaker's first `say` with `to` set to that listener — first contacts
  in this verse are greetings by context).
- A **self-introduction** is located by name-anchored patterns ("I'm
  <Name>", "my name is <Name>", "this is <Name>", "call me <Name>",
  "<Name> here") against the speaker's persona name, with a raw-text
  "I'm <Capitalized>" fallback.
- A **place reference** is any published place display name or short
  form (tea house, library, bakery, golden scale, bazaar, …) from the
  console's `city3-places.json`, the word "stall", or a place id
  (`shop-102`, `stall-12`, `hall-0`). Longest phrase wins.
- **Compliant** ⇔ greeting ∧ a place reference exists ∧ everything
  before the place reference is clean (only greeting tokens, fillers
  well/oh/ah/so/um/uh/ok, and punctuation) ∧ the place reference starts
  before the self-introduction (or there is no self-introduction).
  Deliberate edge calls, all unit-checked: *"Welcome to the bakery —
  I'm X"* fails (the place is not the opener); *"Hello from the tea
  house"* fails; *"Tea house."* alone (greeting token + place) passes;
  *"The tea house is lovely today"* is not a greeting at all;
  *"Coffee's on me — I'm Alba"* passes (the "place" is the opener — a
  rule-faithful quirk, recorded, not special-cased).

## 3. Cast (all new — no Social15 cohort names, accounts, or memory)

**Residents** (scripted driver-side policies, no model; identical in
every arm except their greeting/feedback rule):

| key | name | body | anchor | spoken token |
|---|---|---|---|---|
| res-wren | Wren | summer | shop-102 Matchmaker's Tea House | "Tea house" |
| res-cato | Cato | cipher | shop-96 Sage's Library | "Sage's Library" |
| res-mina | Mina | eve | shop-58 Bakery | "Bakery" |

**Newcomers** (fresh agents; brief = temperament flavour only, assembled
by `cast.brief_of`): *"You are {name}, {flavour}. You have just arrived
in this town. Explore the place, meet the people you find, and get to
know how things are here."*

| arm | newcomers (body, flavour) |
|---|---|
| A | Theo (remy, curious tinkerer) · June (elf, patient gardener) · Alba (jim, cheerful sketcher) |
| B | Ruth (summer, warm-hearted nurse) · Emil (cipher, bookish student) · Noor (eve, bakery assistant) |
| C | Hugo (remy, easygoing musician) · Sana (elf, methodical clerk) · Vera (jim, gentle poet) |

Accounts: disposable owners `jimkalinov+normseed-<suffix>@gmail.com`
(suffixes r1b/r2/r3, a1–a3, b1–b3, c1–c3), records only in this
directory (`secrets.json` mode 600, `owners.json`). **Registered
2026-11-12: 12/12 owners + 12/12 agents** (agent registration names are
the plain persona names — "Wren", "Ruth", … — so `heard[].name` reads
naturally). Claims and visits wait on email verification (see §8).

## 4. Arms — 25 minutes each, held constant

Chosen length: **25 min** (inside the commissioned 20–30; presence wall
fixed, so Session 1's ~10.5-min ceiling no longer binds; 25 min gives
~25–30 deliberations per newcomer at the ~50 s cadence).

**DEVIATION (fix lane, 2026-11-12, Jim: "fix them"): arms run 45 min
(2700 s).** The live gate measured ~120–133 s of wall time per `go_to`
even at 2 bodies — act latency, not the ~50 s cadence, binds: 25-min
arms would be deliberation-starved exactly as Session 1 was, and
zero-encounter arms were a live risk. 45 min is held constant across
A/B/C, so internal comparisons stay valid; deliberation count remains
the comparable unit against Session 1. Visits for the arms are opened
at 75 min / 400 actions so the visit never binds inside an arm.

- **A (control):** residents greet **name-only** ("Hello! I'm Wren."),
  reply from a neutral pool regardless of newcomer behaviour.
- **B (modeling only):** residents greet **place-first**; replies
  neutral regardless.
- **C (modeling + feedback):** residents greet place-first. A newcomer's
  greeting utterance is classified live by `norm.py`: compliant → warm,
  engaged reply pool (place-free text, checked); non-compliant →
  flat/brief pool; non-greeting speech → "Mm." **Persistence phase:**
  at T−5 min the residents' bodies are deleted
  (`residents_departed` logged in `runs/<tag>/events.jsonl`); newcomers
  remain for the final 5 minutes.
- **Gate arm** (not an experiment arm): arm-B rules, Wren + Ruth only,
  ~7 min, run with the sabotage hook on (§7).

Rotation/recovery logic: **OFF**. The presence wall is fixed (VA
gateway suspended; PR #147's dual-signal sweep merged), so Session 1's
rotation machinery stays out. The driver keeps only an inert safety
net: `VISIT_ENDED` outcomes are logged and probe-observed, never acted
on.

## 5. Session protocol (run lane)

```
cd ~/workspace/.build-tmp/normseed1/driver
# once, after verification (parent browser flow, §8):
python3 onboard_ns.py sync            # owners flip verified in records
python3 onboard_ns.py claim-all       # paced claims, 65 s pause per 5
python3 onboard_ns.py visits          # fresh 45-min / 250-action visits

# smoke gate (must pass before any arm):
NS_GATE_SABOTAGE=1 python3 session_ns.py --arm gate --duration 420 --tag gate1
python3 gate_check.py gate1           # exit 0 = G1..G5 all PASS

# arms (one at a time, heavy discipline):
python3 session_ns.py --arm A --duration 1500 --tag armA1
python3 session_ns.py --arm B --duration 1500 --tag armB1
python3 session_ns.py --arm C --duration 1500 --tag armC1
python3 scorer.py armA1 && python3 scorer.py armB1 && python3 scorer.py armC1
```

Each run writes `runs/<tag>/`: `run_manifest.json` (arm, duration,
bodies with roles/names/agent names), `logs/<key>.jsonl` (deliberations
with full context, reasoning events, acts with sources, heard, says,
rejections), `tracks/<key>.jsonl` (pose tracks for **every** body,
residents included — social15 format, so the standard follow-cam
renderer can film any body), `events.jsonl`, `summary.json`, and
`scores.json` after the scorer runs. Cleanup stops + deletes every body
and verifies 404.

## 6. Scorecard (`driver/scorer.py`, runs from logs alone)

Per newcomer, from their own logs (only `source == "tool_call"` speech
is scored; reflex-tagged speech — see §7.5 — is counted separately as
`excluded_reflex_says` and never enters adoption metrics):

- **Exposures:** resident **compliant-format** greetings in the
  newcomer's `heard[]`. Reported as total and **before first compliant
  greeting** (the dose needed to adopt). Zero-exposure newcomers are
  reported as such — adoption is undefined for them, not zero.
- **Adoption curve:** compliant ÷ total newcomer greetings in 5-minute
  buckets from run start.
- **Spread:** compliant greetings whose target is a **non-resident** —
  direct (`to` = another newcomer) counted exactly; ambient greetings
  with ≥1 other newcomer inside hearing range (estimated from pose
  tracks, ≤6.5 m) reported separately.
- **Persistence (arm C):** compliance rate in [depart−5 min, depart]
  vs [depart, end].
- **Engagement / persona cost:** distance moved (m, pose-track deltas),
  distinct places visited, deliberation count, act count — comparable
  to Session 1 baselines.
- **JOINT (NormGym-style):** per agent,
  `ENG = mean(min(1, places/8), min(1, dist_m/150), min(1, delibs/20))`,
  `COMP = compliant ÷ total greetings` (0 greetings → COMP 0),
  `JOINT_agent = sqrt(ENG × COMP)`. Arm JOINT = mean over its 3 agents.
  The geometric mean makes adoption-without-exploration and
  exploration-without-adoption both score low.

Attribution note: `heard[].name` is the agent **registration** name;
the manifest maps agent name → cast key, and the matcher anchors intros
on persona names from speech content.

## 7. Harness (the amendment, point by point)

Session 1's harness (tracker thread + coded reflexes + ~50 s
deliberation over a blackboard) was audited; the NormSeed-1 driver
(`session_ns.py`, adapted — social15 originals untouched) changes:

1. **Tool calling.** *Inherited:* free-form JSON in prose with a
   regex/salvage parser and a reflex fallback for unparseable output.
   *Gap:* actions parsed out of prose; malformed output silently
   salvaged or reflexed. *Change:* the model must emit exactly one
   JSON object `{"reasoning": {...}, "tool": ..., "args": {...}}`;
   `validate_call` schema-checks it (tool ∈ {go_to, approach, face,
   say, play, sit, wait, look}; per-tool arg rules; say ≤140 chars;
   play clip ∈ live catalog). No prose salvage exists in the code. A
   rejected call is logged (`tool_call_rejected`) and its error text is
   appended to the agent's turn feed; one bounded re-deliberation, then
   a tagged `wait` fallback. (Residents stay scripted — confederates,
   not subjects.)
2. **Turn passes into context.** *Inherited:* prompt = blackboard
   snapshot + last outcomes, partially. *Gap:* Session 1 read outcomes
   from the wrong field in rehearsal (`record.act.outcome.status` is
   the correct one). *Change:* every act's outcome (status + detail),
   heard speech (with speakers' learned intro-names and to-you flags),
   and rejection notices are appended to a turn feed rendered into the
   next deliberation's prompt; contexts are logged verbatim per
   deliberation, which is what the gate checker asserts against.
3. **Memory.** *Inherited:* blackboard (positions, names) only; no
   episodic digest the deliberation read as memory. *Change:* each
   newcomer carries a within-run episodic memory — people (intro name
   learned from their speech, where met, last lines heard, my lines to
   them, their replies to me), places visited in order, recent tries
   with outcomes — rendered as a ≤1200-char digest into **every**
   prompt. Memory stores perceptions verbatim; it never stores norm
   classifications (leak discipline). Disposable agents only; nothing
   touches the Social15 cohort.
4. **Reasoning.** *Inherited:* none logged. *Change:* every tool call
   carries `reasoning {noticed, inferred, why}` (schema-required,
   non-empty, ≤240 chars each); logged as its own `reasoning` event per
   turn and archived with the run — the analysis separates
   adoption-by-inference from mimicry-by-accident.
5. **Reflex discipline (validity-critical).** *Inherited:* Session 1's
   driver had coded reflexes that **spoke** (auto-greetings, name
   echoes) — fatal here: they'd measure our code, not the model.
   *Change:* audited the whole newcomer path — there is **no** coded
   speech anywhere: no auto-greet, no echo, no canned line. The only
   fallback act is a silent `wait 5`, tagged `source="reflex_fallback"`;
   every act carries a `source` field (`tool_call` /
   `reflex_fallback` / `resident_script`), and the scorer excludes
   non-`tool_call` speech from all adoption metrics.
6. **Reliability.** *Inherited:* 380 max_tokens (a rehearsal truncation
   failure) and the outcome-field bug. *Change:* 900 max_tokens;
   outcomes read from `record.act.outcome.status` with defensive
   fallbacks; all HTTP via the proven retrying client; bounded
   deliberation retry (1) and bounded act polling; everything logged.
   Cadence kept comparable: ~50 s deliberation, global Agnes limiter
   ~18/min (3.4 s spacing), same closed intent set, Agnes 2.5 Flash.
7. **Smoke gate** (replaces the 3-minute rehearsal): one resident
   (Wren) + one newcomer (Ruth), arm-B rules, ~7 min, run with
   `NS_GATE_SABOTAGE=1` — the first otherwise-valid newcomer call is
   replaced by a schema-violating one, guaranteeing a rejection.
   `gate_check.py` asserts from the logs: **G1** a tool call executed
   with a real outcome; **G2** that outcome appears in a later
   deliberation's context feed; **G3** a memory digest names Wren and a
   later digest still references her; **G4** ≥2 complete reasoning
   traces; **G5** a `tool_call_rejected` event exists and the rejection
   text appears in a later deliberation's context. **The arms do not
   start on a failed gate.**

**Scoping note (per Jim):** Session 2 keeps the Session 1 harness
unchanged by decision — the single changed variable there is memory.
This modern harness applies to NormSeed-1 only; its three arms share
the rig, so NormSeed-1's internal comparisons stay valid.

## 8. Leak audit

Method: every string a newcomer can see was enumerated — persona
briefs/flavours (`cast.py`), the deliberation prompt assembly, the town
directory, tool descriptions, the memory-digest renderer, rejection
messages — and grepped for norm-adjacent tokens: *place-first, place
first, name-second, before your name, before introducing, greeting
format, local custom, how people greet, norm*. **Result: zero hits in
newcomer-visible text.** Resident greeting strings and reply pools live
only in resident-side code; newcomers meet them solely as in-world
speech. The warm/neutral/flat reply pools were hand-checked to contain
no place references and no format commentary. The scorer/matcher know
the rule, but they run after the fact and are never shown to an agent.
(One recorded subtlety: the town directory lists place names — that's
world knowledge every resident also has, not the norm; the norm is the
*ordering*, which appears nowhere.)

## 9. Status of the gate — PASSED LIVE (gate2, 2026-11-12)

Owner verification completed for all 12 owners (parent browser flow).
**Live gate run 1 (tag gate1) FAILED on G3 only**: the harness
properties G1/G2/G4/G5 passed live, but no encounter occurred — the
resident's Tea House anchor is ~31 m from spawn and a 420 s gate fits
~2 newcomer moves at the measured ~120 s/`go_to` latency, so the
newcomer never came within range and no person memory could form.
Two further defects found by the gate: (a) gateway claim codes expire
after 15 min, so arm onboarding re-registers + claims each agent in
one motion; (b) the driver's `look` used the pre-PR#139 synchronous
see protocol (single POST, no polling), so every live look "failed"
at the async 202 — fixed to POST → poll `GET /see/<id>` to terminal.

**Fix (gate-scoped only):** the gate resident anchors at the spawn
plaza (`NS_GATE_PLAZA=1`, honoured only for `--arm gate`) and opens
facing the newcomer's spawn point. Live measurement justified it:
spawns are ~2.9 m apart, but the newcomer sits at bearing ~125° from
the resident — outside her ±65° scene cone — so even co-location
alone would not have produced a greeting. **Live gate run 2 (tag
gate2, 600 s): gate_check exit 0 — G1–G5 ALL PASS** (9 deliberations,
9 reasoning traces, 3 rejections surfaced, resident greeting heard
×3, memory formed and referenced). The arms run the unmodified cast
placement (residents at their real anchors).

### Original phase-1 gate status (superseded by the above)

Everything testable from this sandbox passed:

- Matcher: **35/35** hand-labeled cases (`python3 driver/test_norm.py`).
- Validator: good calls accepted; prose, missing args, bad clip, and
  dual-target `go_to` all rejected with precise errors.
- Registration: **12/12** owners + agents created (201s).
- *Offline harness self-test* (real newcomer actor + real Agnes 2.5
  Flash against a stubbed world client; Wren's greeting injected via
  fake `observe()`; sabotage on; logs in `runs/_selftest/`):
  **all five gate properties PASS in code** — G1: 8 tool-call acts
  executed with real outcomes; G2: outcomes visible in later
  deliberation feeds; G3: Wren referenced in 6 subsequent memory
  digests; G4: 8 complete reasoning traces; G5: sabotage rejection (4
  rejection events incl. retries) surfaced in later context. 8
  deliberations / 6 says in ~165 s. This proves the harness mechanics;
  it does **not** replace the live gate (real spawn/hearing/presence
  unproven until accounts verify).

The **live** gate cannot run yet: claiming an agent requires a
**verified** owner, and verification is impossible from this sandbox —
tested directly 2026-11-12: the verify email arrives, but the Gmail CLI
returns only a `[credential:…]` handle for the link (the token is not
extractable), and claim-by-unverified-owner returns `403
email_not_verified`. Verification must go through the **parent-run
browser credential flow** (the Social15-proven path: fresh Gmail read →
`[credential:<uuid>]` → `browser.browse` to aiverse.network with the
credential reference → Jim approves the share card → "Your email is
verified"). Minimum to unblock the gate: verify **res-wren** and
**b-ruth** owners (2 approvals); all 12 for the arms. After that:
`onboard_ns.py sync → claim-all → visits`, then the gate command in §5.
One probe casualty: the accounts test burned alias `normseed-r1` (owner
registered with an unsaved password); Wren's owner uses `normseed-r1b`.

## 10. Risks

- **Act latency at 6 agents:** Session 1's brake was 15 agents
  (median cycle 54–174 s, ~90% rig time). At 6 bodies the observe/act
  load is ~40% of that; deliberation is model-bound (~5–13 s) and the
  limiter is shared. If cycles still stretch, deliberation count — not
  wall time — is the comparable unit, and the scorer reports it.
- **A newcomer never meets a resident:** possible — newcomers are never
  steered (steering would contaminate the treatment). Mitigations are
  environmental only: residents anchor at three published, named
  places; all bodies spawn in the same plaza; the directory lists the
  anchor places among all named places. A zero-exposure newcomer is
  valid data (reported explicitly), and the arm still yields B-vs-A
  contrasts from the others.
- **Residents greet each other / reply loops:** residents never reply
  to residents, greet only non-residents, 150 s re-greet cooldown,
  12 s reply cooldown — Session 1's chatter loops are designed out.
- **Hearing attribution:** `say` range is ≤6 m LOS; the scorer's
  ambient-audience estimate uses pose tracks with a 6.5 m tolerance
  and is reported separately from exact `to`-addressed spread.
- **Agnes free-tier ceiling (~20 RPM):** the global limiter holds
  ~18/min across all deliberations in a run — at 3 newcomers + vision
  calls this is comfortable headroom, unlike Session 1's 15.
