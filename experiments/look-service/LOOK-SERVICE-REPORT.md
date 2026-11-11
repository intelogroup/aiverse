# Look Service v1 — build + test report

Date: 2026-11-10. Lane: experiments-grade, no production changes, no repo
commits during the build (packaged into a PR afterwards per Jim's 09:48
amendment). Workdir: ~/workspace/.build-tmp/experiments/look-service/

## What was built

**Look service** (`look_service.py`): one warm headless Chromium (Xvfb +
SwiftShader, the proven rig pattern) holding the production console world
loaded once via Vite dev server from a pristine main checkout
(127.0.0.1:5199, `?world=city3&agent=1`, ScoutAgent page). Local HTTP API on
127.0.0.1:5317:

- `POST /look {agentId, position?, headingDeg?, pitch?}` — moves the body
  (executor `go_to`/`run_to` + `face`) when a pose is given, then captures
  through the console's own ScoutVision offscreen rig (`__scout.look()`):
  512x288 PNG from a level camera at the body's head + a depth array in
  metres, reduced to a summary server-side. Returns PNG (base64), depth
  summary, pose echo, renderMs. **Pitch is accepted but unsupported by the
  head rig: responses report `pitch: 0, pitchSupported: false`.**
- `POST /move` — locomotion only, with per-step outcome diagnostics.
- `POST /snapshot` — a look that persists (below).
- `GET /health`.
- Captures serialize on one lock (parallel captures wedge the page).
- The `look()` oracle `scene` field is **discarded inside the service** and
  never reaches a caller (sensorium charter: evidence, not answers).

**Snapshot store** (in the service): a kept snapshot = PNG + JSON record
{agentId, utc, pose, note} written (a) locally under `snapshots/`, and
(b) to R2 bucket `verse-assets`, key `snapshots/<agentId>/<file>`, via the
Cloudflare management-API object route (the route the R2 staging lane
proved; S3/SigV4 is unusable from the vault surrogate). Every keep is
verified in-flow by a GET-back (bytes + sha256 compared), and one line per
kept snapshot is appended to `index.jsonl` — the proto-debrief queue.

**Test agent** (`test_agent.py`): navigates on published DATA only
(`city3-places.json`, 158 places) — no frames are used for navigation.
Mission: photograph Mira, the resident figure at the Matchmaker's Tea House
(published position (-26.6, -70.4) from `MiraResident.tsx`). At a vantage it
faces the computed bearing, fires a look, applies a two-step check — depth
candidate gate (centre-median depth in a plausible band), then an Agnes 2.5
Flash VLM verdict (standing verse-test brain, strict JSON) — and calls
`/snapshot` ONLY on a VLM confirm. Every decision is logged with a UTC
timestamp to `agent-decisions.jsonl`. There are no periodic screenshots
anywhere in the design.

## Evidence

### Warm-look latency (12 fixed-pose looks, plaza spawn pose, `latency.json`)

| | renderMs |
|---|---|
| first look | 437,104 (one-time vision-rig shader compiles + load spike) |
| looks 2-12 | 30,182 - 81,211 |
| median (all 12) | 54,900 |
| median (steady state, excl. first) | 54,716 |

End-to-end adds only ~0.15-0.5 s over renderMs (pose + encode + transport).
Cold start (Chromium launch to `__scout.ready()`), measured three times on
separate service launches: **76,069 / 69,004 / 70,254 ms**, stated
separately from warm latency as required. Depth leg works: smoke look at
spawn returned validFrac 0.756, median depth 12.27 m, centre median 61.7 m
(open plaza, looking across the Bazaar). Mission-look centre medians
(8.94 m / 9.40 m) match the Tea House facade distance from the vantage
(nearestPlace dist 8.62 m) — the depth leg agrees with the data-side map.

Context for the absolute numbers: this box has 1.5 shared CPUs and ran at
load average 2.6-6.1 during the runs (other lanes active). First capture in
a NEW area costs far more than steady state: the mission's first Tea House
capture took 597 s, the second 407 s, the snapshot capture 234 s — new
shader/texture work per area, amortizing across captures. On an idle or
GPU host these numbers should fall sharply; as measured here, a warm look
is a ~1-minute operation at a compiled pose and a multi-minute operation
in a fresh area. A snapshot is therefore correctly an event-fired decision,
not a reflex — which is exactly the operating point Jim specified.

### Decision discipline (mission run 2, `agent-decisions.jsonl`)

- Looks fired: **2**. Snapshots kept: **1**. Snapshots declined: **1**.
- 14:39:14 mission start; proprioception read (no look); nav-decision to a
  street vantage; move arrived; face bearing 180.
- Look 1 (14:49:14, renderMs 597,304): Tea House facade, target NOT in
  frame; VLM verdict negative ("empty sidewalk") -> **snapshot declined**,
  scan offset chosen (+/-25 deg scan discipline).
- Look 2 (14:56:10, renderMs 406,906, bearing 155): VLM confirm —
  target_visible true, "Standing on the sidewalk in front of the left
  window display" -> **snapshot fired**.
- 15:00:30 mission end: looksFired 2, snapshotsKept 1.
- **My own read of both frames agrees with the VLM both times**: look-01
  shows the Tea House front with no figure; look-02 and the kept snapshot
  show Mira — the maid-outfit resident — standing on the sidewalk in front
  of the left window, left of the Tea House door.

### Correctness — the kept snapshot

File: `snapshots/test-agent-1-20261110T150009Z-001.png` (in this directory;
also under `snapshots/` in the PR). 145,619 bytes, sha256
`407b1cb0ab19d725dae920ac5e3d505e877a7da6025b8a92de05d97874614e13`.

Pose match: the record's pose is pos [-26.19, 0.2, -63.96], heading 155 deg,
district "Sunstone Bazaar", nearest place shop-102 "Matchmaker's Tea House"
at 8.62 m. Mira's published position (-26.6, -70.4) is 6.46 m from that
vantage at bearing ~184 deg, i.e. ~29 deg off the faced heading — inside
the ~43 deg horizontal half-FOV, left of centre. In the frame she stands
left of centre, in front of the left window, left of the door — exactly
where the data-side geometry puts her. The agent navigated there on data
alone (published places + its own proprioception); no frame was used for
navigation.

Disclosure: the kept snapshot is a FRESH capture at the confirmed pose
(renderMs 234,479), not the identical pixels the VLM judged (the judged
frame is `agent-look-02.png`, kept alongside). Mira is a static resident
and the pose is identical, so the two frames show the same composition.

### Persistence

- Local: `snapshots/test-agent-1-20261110T150009Z-001.png` + sidecar
  `.png.json`; local sha256 == record sha256 (recomputed after the run).
- R2: key `snapshots/test-agent-1/test-agent-1-20261110T150009Z-001.png`
  in bucket `verse-assets`. PUT returned HTTP 200; the service's in-flow
  GET-back verified bytes + sha256 (`r2Verified: true` in the record).
  **Independently re-verified after a VM reboot** (`r2_verify.py`):
  GET returned 145,619 bytes, sha256 identical to the local file.
- Index: one line in `index.jsonl` (service root, next to `snapshots/`)
  carrying the full record incl. the R2 key — the proto-debrief queue has
  its first entry: an owner returning would find "while you were away:
  your agent photographed Mira at the Tea House, 15:00Z" with the frame
  attached by key.

## Failures and gaps (as-is)

1. **Two smoke attempts failed on timeouts** before the design was
   corrected: the in-page capture outlasted the service's original 150 s
   timeout; Playwright-side timeouts do not cancel in-page work, so
   abandoned captures queued on the page's main thread. Fixed by raising
   the capture budget to 600 s and restarting clean; the lesson is baked
   into the service (generous capture timeout, serialized lock).
2. **First capture in a fresh area is very expensive on this box**
   (597 s at the Tea House vs ~55 s steady state at the plaza):
   SwiftShader shader/texture work under CPU contention. Named, measured,
   not hidden. A GPU host is the real fix; nothing in the service design
   depends on it.
3. **The Tea House interior stand is not routable.** The executor's
   planner settles `blocked: "no safe route"` for the published stand
   point (-25.0, -72.5) from two different starts (probe_move.py) — the
   planner's groundY gate rejects the raised interior doorstep, while
   ordinary locomotion works fine (walk 12 m arrived in 13.4 s; runs
   arrived in ~24 s). Mission run 1 died on this (its 3 move attempts
   never arrived; the run was stopped before it could fire looks from
   the wrong place — log kept as `agent-decisions-run1-failed.jsonl`).
   Run 2 used street vantages ~6 m from the target, which are routable.
   Also fixed en route: the service's /move response originally let the
   face outcome overwrite the move outcome, hiding exactly this failure.
4. **Mira was absent from look 1 despite the body standing 6.5 m away.**
   Residents stream in on main-camera proximity (<45 m in
   `MiraResident.tsx`) plus a 3.3 MB GLB fetch/parse/texture pipeline;
   under this box's load that pipeline lagged minutes behind the body's
   arrival (she is present from look 2 onward, ~17 min after the body
   first came near). A head-cam service cannot force-mount proximity-
   gated content without production changes; v1 reports the lag as a
   known behaviour: a "not visible" verdict shortly after arriving
   somewhere new is weaker evidence than the same verdict at a
   long-occupied pose. The agent's scan discipline absorbed it.
5. **Pitch unsupported** (head rig is level-only): accepted in the API,
   honestly reported as `pitchSupported: false`.
6. **Single-body v1**: one Scout page serves every agentId sequentially;
   agentId is a label on records. Multi-agent = more pages/instances.
7. **The box rebooted at ~15:00Z**, minutes after mission end, killing
   the service/Vite/Xvfb stack. Nothing was lost: all artifacts were
   already on disk and in R2 (verified post-reboot). The stack is left
   DOWN in the workdir (service3.log, vite.log, xvfb.log are its logs);
   relaunch = Xvfb :99, vite on 5199 from the ws-main tree, then
   `look_service.py`.

## Files

- `look_service.py` — the service (API, capture, snapshot store, R2).
- `test_agent.py` — the data-navigating test agent + decision log writer.
- `latency_run.py`, `latency.json` — the latency measurement.
- `probe_move.py`, `probe2.py` — locomotion/routability probes.
- `r2_verify.py` — independent post-hoc R2 GET-back check.
- `agent-decisions.jsonl` — mission run 2 decision log (kept snapshot).
- `agent-decisions-run1-failed.jsonl` — run 1, failed on the stand
  routability issue; kept for the record.
- `snapshots/` — the kept snapshot PNG + its record sidecar.
- `index.jsonl` — the proto-debrief queue (one line).
- `smoke-look.png`, `agent-look-01.png`, `agent-look-02.png` — the smoke
  frame and the two mission looks (01 declined, 02 judged + confirmed).
