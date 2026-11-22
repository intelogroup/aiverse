# NormSeed-1 — Analysis

**Question:** can fresh agents infer and adopt an arbitrary, unstated
community norm (greet **place-first, name-second**) purely from
residents modeling it plus social feedback — vs modeling-only and
no-modeling baselines?

**Headline result:** the experiment's social machinery worked, the
gate passed live 5/5, and all three arms ran their full length — but
**the treatment never fired**. Across Arms A and B, no newcomer ever
came within greeting range of a resident: total resident speech heard
by newcomers was **zero**, so exposures were 0 for every newcomer and
adoption is *undefined* (not zero) for the arms as run. The binding
constraint is the **encounter rate**, not norm inference: newcomers
socialised richly with each other around the plaza/hall circuit and
almost never entered the three anchor interiors where residents sit.
Arm C is reported in the same terms below. The one near-miss is
instructive: Emil (Arm B, "bookish student") entered both the Tea
House and the Library and passed **6.2 m** from each resident —
1.2 m outside greeting range — without speaking once.

Everything below is computed from the run logs by `driver/scorer.py`
(delivered speech only — see the scorer-delivery note) and the pose
tracks. Per-arm `scores.json` sits in each `runs/<tag>/` directory.

---

## 1. Look-service diagnosis (fix step 1)

**Symptom (gate1):** both of Ruth's `look` calls stayed "running"
gateway-side and were logged `see_failed`.

**Diagnosis: a driver protocol bug, not a service outage.**
- Live health at 19:50Z: the tunnel `/health` returned 200 —
  `{ok: true, ready: true, warmSince: 15:39Z, looksServed: 5,
  lastError: null}`. The service on Jim's Mac was up the whole time.
- PR #139 had made `/world/see` **asynchronous**: POST answers
  `202 {see: {id, state: "running"}}` and the photo arrives via
  `GET /see/<id>` long-polls. `session_ns._do_see` still used the
  pre-#139 contract — one POST, demanding a synchronous 200 with
  `photoPng` — so every look was abandoned at the 202 after ~3 s
  while the job itself completed gateway-side.

**Fix:** `_do_see` now polls `GET /see/<id>?waitMs=10000` to a
terminal state (done/failed/photo), 240 s cap, stop-flag aware;
`see_failed` logs carry the terminal state.

**Live proof of the patched flow** (`probe_see.py`, ns-wren):
POST 202 → 5 polls → `done` at 68.7 s; PNG 176,637 B, 512×288,
header verified, renderMs 1,052 / latencyMs 64,223; the frame is a
real first-person plaza view (`probe-see.png`). Cleanup DELETE 200 →
GET 404. Caveat: end-to-end see latency is variable (~10 s in the
deploy proof, ~69 s here) — `look` is a deliberation-expensive
sense, and Arm A used it successfully (5 `see` + 5 `see_described`
for Theo; see §3).

## 2. Smoke gate (fix step 2)

**gate1 (420 s): FAIL — G3 only.** G1/G2/G4/G5 passed live. No
encounter occurred: the resident's Tea House anchor is ~31 m from
spawn, a `go_to` costs ~120–133 s of wall time, and the newcomer's
two moves never brought her within range, so no person-memory could
form. (G3's mechanism had already passed the offline self-test.)

**Gate-scoped fixes** (gate arm only; the arms' design untouched):
- The gate resident anchors **at the spawn plaza** and opens with
  `face {headingDeg}` toward the newcomer's spawn point. Live
  measurement forced the facing half of this fix: the two spawns are
  ~2.9 m apart, but the newcomer sits at bearing ~+125° from the
  resident — outside her ±65° scene cone — so co-location alone
  still produces no greeting. Probe-verified: face settles in ~7.5 s,
  newcomer then at bearing 1.1°, 2.95 m.
- Gate duration 600 s.

**gate2 (600 s): PASS — `gate_check.py` exit 0, G1–G5 all PASS.**
b-ruth: 6 tool-call acts, 9 deliberations, 9 reasoning traces,
3 rejections surfaced in later context. Wren greeted "Tea house —
I'm Wren." 10 s after facing (20:00:17Z), re-greeted twice, replied
once; Ruth heard 3 utterances and formed the memory the checker
requires. Bodies cleaned up (DELETE 200 → 404).

## 3. Arm A — control (residents greet name-only, neutral replies)

**Run integrity:** 45-min arm truncated in-world at ~29.4 min by an
environmental incident: **PR #153 merged at 20:41:29Z, Render
redeployed, and the sim restart deleted all six bodies**
(observe → 404 `no_body` from 20:43:18Z; the visits, held in
Postgres, survived). The driver then had no recovery (Session 1's
was deliberately removed in this design) and deliberated against
frozen blackboards for the last ~16 min. Two scorer-level
consequences, both fixed before Arm B (see §6): phantom `say_sent`
events after the wipe initially inflated greeting counts (Theo 11,
June 15); the delivered-only numbers below supersede them.

| newcomer | delibs (in-world) | distance | places | greetings (delivered) | compliant | exposures | ENG | JOINT |
|---|---|---|---|---|---|---|---|---|
| Theo | 30 | 488.0 m | 21 | 2 | 0 | 0 | 1.00 | 0.0 |
| June | 34 | 79.6 m | 6 | 4 | 0 | 0 | 0.76 | 0.0 |
| Alba | 27 | 207.5 m | 12 | 3 | 0 | 0 | 1.00 | 0.0 |

Residents: deployed to anchors (Wren Tea House, Cato Library, Mina
Bakery — Mina seated), **0 says, 0 heard**. Newcomers heard 11–13
utterances each — all from each other. Closest newcomer↔resident
approach (track-sampled): 31.2 m (Theo↔Mina). Adoption undefined
(zero exposures); baseline compliance 0/9 delivered greetings is
consistent with no spontaneous place-first style, but with zero
resident contact the arm's cleanest reading is geographic, not
behavioural. Theo also exercised the repaired `look` path: 5 photos
taken and described, 1 failure.

## 4. Arm B — modeling only (place-first greetings, neutral replies)

**Run integrity:** clean full 45 min. The new body-loss recovery was
armed and never needed (no `body_lost` events); tracks cover the
whole run; deliberations 47/39/45.

| newcomer | delibs | distance | places | greetings (delivered) | compliant | exposures | ENG | JOINT |
|---|---|---|---|---|---|---|---|---|
| Ruth | 47 | 539.2 m | 16 | 2 | 0 | 0 | 1.00 | 0.0 |
| Emil | 39 | 1,171.2 m | 38 | 0 | 0 | 0 | 1.00 | 0.0 |
| Noor | 45 | 740.8 m | 17 | 2 | 0 | 0 | 1.00 | 0.0 |

Residents again: **0 says, 0 heard**. Ruth and Noor heard 7
utterances each — each other's. Emil heard nothing and **said
nothing in 45 minutes**, despite entering both anchor shops:
shop-102 (Tea House) and shop-96 (Library) are in his visited-places
list, and his closest sampled approaches were **6.2 m to Wren and
6.2 m to Cato** — just outside the ≤5 m greeting trigger, and he
never spoke, so the residents' reply path never fired either.
Everyone else in both arms stayed ≥31 m from every resident at all
times.

**Interpretation:** B vs A shows no measurable difference because
neither arm delivered the treatment. The verse's social geometry —
residents seated inside named interiors, newcomers circuiting the
plaza, hall and stalls and choosing destinations from a 78-place
directory — yields an encounter rate of ~0 per 45 min at these
anchors. Any future NormSeed iteration must treat *exposure
engineering* (resident placement on the newcomers' actual circuit,
or greeter mobility) as a first-class design variable, held constant
across arms; changing only one arm's placement would confound the
contrast.

## 5. Arm C — modeling + feedback (+ persistence phase)

**Run integrity:** two environmental incidents, neither fatal. The
first attempt's driver process took an external SIGTERM ~5 min in
(21:53–21:58Z, cause not diagnosable from here); all six bodies were
found still attached, were deleted (200 → 404), the partial was
preserved (`runs/armC-partial-2153Z/`), and the arm was re-run fresh
on the same visits. During the re-run, **another production deploy
wiped all six bodies at 22:27:55Z** (gateway `/version` has since
moved past PR #153's SHA) — and this time the new recovery fired:
every body re-attached by 22:28:10Z (**15 s**), residents re-walked
to their anchors (`resident_deployed` ×2 each), and deliberations
continued to 45/45/49 with full-length tracks. The persistence phase
executed on schedule (`residents_departed` at T−5 min).

| newcomer | delibs | distance | places | greetings (delivered) | compliant | exposures | ENG | JOINT |
|---|---|---|---|---|---|---|---|---|
| Hugo | 45 | 734.9 m | 21 | 8 | 0 | 0 | 1.00 | 0.0 |
| Sana | 45 | 577.6 m | 21 | 2 | 0 | 0 | 1.00 | 0.0 |
| Vera | 49 | 401.5 m | 17 | 4 | 0 | 0 | 1.00 | 0.0 |

Residents: **0 says, 0 heard** — the feedback treatment, like the
modeling treatment, never fired. Closest approach: Sana passed
**9.7 m** from Wren (outside both the ≤5 m greeting trigger and the
≤6 m hearing radius); Hugo ≥61 m, Vera ≥42 m from everyone.
Persistence is vacuous for the norm (nothing was adopted to
persist); the social behaviour itself persisted — Hugo greeted
fellow newcomers twice in the post-departure window (bucket 8),
in the ordinary name-first style, as he had all run.

## 6. Rig changes made by the fix lane (all disclosed)

1. **`look` async polling** (§1) — driver only; no design change.
2. **Gate anchor + facing** (§2) — gate arm only, env-gated
   (`NS_GATE_PLAZA=1`); arms run the cast's real anchors.
3. **Arm length 25 → 45 min** — Jim's fix word after gate1 measured
   ~120 s/`go_to`; held constant across A/B/C. Visits 75 min /
   400 actions per arm.
4. **Body-loss recovery** (after Arm A) — tracker flags
   `404 no_body`; actors pause (no phantom deliberations) and
   re-attach throttled; residents re-walk to their anchors. Fires
   only on a sim-side wipe; never steers anyone. Armed for B and C;
   needed by neither (no wipes recurred).
5. **Scorer delivery rule** (after Arm A) — a greeting counts only
   if its say act delivered (outcome `done`; post-fix logs carry the
   outcome on `say_sent`; legacy logs are matched to their act
   events). `undelivered_says` is reported per newcomer (Arm A:
   Theo 10, June 12, Alba 0 — mostly post-wipe phantoms).
   Conservative bias: a say whose act settles after the driver's
   30 s wait scores undelivered even if the sim executed it.
6. **Onboarding** — all 12 owners verified (parent browser flow);
   the 10 non-gate agents were re-registered + claimed in one motion
   each (gateway claim codes expire after 15 min), landing on the
   `ns-*` name fallbacks (`ns1-mina` for Mina). Persona-name
   anchoring is unaffected: memory/scoring key on names spoken
   in-world.

## 7. Scorecard summary

| arm | exposures (all newcomers) | compliant / delivered greetings | spread | persistence | JOINT |
|---|---|---|---|---|---|
| A (control) | 0 | 0 / 9 | 0 | — | 0.0 |
| B (modeling) | 0 | 0 / 4 | 0 | — | 0.0 |
| C (modeling + feedback) | 0 | 0 / 14 | 0 | vacuous (nothing adopted) | 0.0 |

- **Exposures before first compliant greeting:** undefined for all
  nine newcomers (no compliant greeting ever followed an exposure,
  because there were no exposures).
- **Adoption curves:** flat zero in every 5-min bucket of every arm
  (per-newcomer buckets in each `runs/<tag>/scores.json`).
- **Engagement** was healthy throughout (ENG 0.76–1.00; 27–49
  deliberations, 79.6–1,171.2 m, 6–38 places per newcomer) — the
  agents were busy, social with each other, and mobile. The null
  result is not an activity failure.
- **Persona/task cost:** no arm shows a deliberation or mobility
  deficit vs the others; the treatments cannot have cost anything,
  never having been delivered.
- **Answer to the commissioned question:** *undetermined — the
  delivery mechanism (resident↔newcomer encounters) produced zero
  doses in all three arms.* What the experiment did establish:
  (1) the modern harness passes its live gate 5/5 and sustains
  39–52 deliberations per agent per 45 min at 6 bodies; (2) fresh
  agents socialise spontaneously with whoever is actually near
  (27 delivered greetings, all newcomer↔newcomer); (3) nobody
  produced the place-first format spontaneously (0/27), so the
  format is not an Agnes default mannerism — a future run that
  *does* deliver exposures starts from a clean baseline; (4) the
  verse's encounter geometry is the binding constraint, quantified
  above — the design variable a NormSeed-2 must fix first, held
  constant across arms.

## 8. Films

Third-person follow-cam replays (independent observer page, pose
tracks only), 10 fps × 1350 frames = 135 s each, H.264 + faststart,
854×480, chapters alongside (`films/data/<key>.chapters.json`).
Independently ffprobe-verified: codec h264, 1350/1350 frames,
moov-before-mdat.

| film | subject | size |
|---|---|---|
| `films/armA1-a-theo.mp4` | Theo (Arm A) — the explorer; 488 m, 21 places, 5 repaired-`look` photos | 14,319,191 B |
| `films/armB1-b-emil.mp4` | Emil (Arm B) — 1,171 m, 38 places; enters the Tea House and Library, passes 6.2 m from both residents, never speaks | 21,093,826 B |
| `films/armC1-c-hugo.mp4` | Hugo (Arm C) — the most social newcomer; 8 delivered greetings incl. post-departure | 17,347,736 B |

Frame spot-check (Emil at session 32:51, "at shop-102"): the
follow-cam shows him on the street directly before the Matchmaker's
Tea House storefront — the near-miss geometry made visible.

**World-GLB disclosure:** films render the Session-1 light bake
(8,113,112 B; 0.69 s/frame), not the post-#149 production world.
The production GLB (87,289,408 B, sha256 443ea08b22fab420…, staged
at `films/world-full.glb`) was benched and rejected on measurement:
it did not finish loading + 30 frames within 280 s under
SwiftShader on this box. Consequences, same as Session 1's films:
demolished blocks render standing and interiors are the earlier
bake; actor motion, timing, and encounters are the runs' own track
data. (The page HUD also carries the Session-1 rig's inherited
label text; the data and chapters are NormSeed-1's.)
