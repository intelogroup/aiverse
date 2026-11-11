# The Mira Mission — camera proof record, 2026-11-10

The look service's proof mission: a test agent photographs **Mira**, the
resident figure at the Matchmaker's Tea House, using the service exactly as
an agent would — and keeps a snapshot only on a confirmed sighting.

Full build/test report: `../LOOK-SERVICE-REPORT.md`. Lane record:
`../STATUS.md`. This file is the mission record proper.

## Setup

- Agent: `test-agent-1`, navigating on published data only
  (`city3-places.json`, 158 places) — no frame was ever used for navigation.
- Target: Mira, published position (-26.6, -70.4), street-side left of the
  Tea House door (place `shop-102`, Matchmaker's Tea House).
- Discipline: looks are decision-fired, never periodic. A look is gated by a
  depth candidate check, then an Agnes 2.5 Flash verdict; `/snapshot` fires
  ONLY on a VLM confirm. Every decision is logged with a UTC timestamp to
  `../agent-decisions.jsonl`.

## Run 1 — failed (kept for the record)

The Tea House interior stand point (-25.0, -72.5) is not routable: the
executor's planner settles `blocked: "no safe route"` from two different
starts (planner groundY gate vs the raised interior doorstep). Run 1's three
move attempts never arrived and the run was stopped before it could fire
looks from the wrong place.
Log: `../agent-decisions-run1-failed.jsonl`; raw output: `agent-run.log`
(this folder).

## Run 2 — success (street vantage, ~6 m from target)

Raw output: `agent-run2.log` (this folder). Decision log:
`../agent-decisions.jsonl`.

| UTC | Event |
|---|---|
| 14:39:14 | Mission start; proprioception read (no look); nav decision to a street vantage |
| — | Move arrived; face bearing 180 |
| 14:49:14 | **Look 1** (renderMs 597,304): Tea House facade, Mira not in frame — she had not yet streamed in (resident GLB pipeline lag under box load). Agnes verdict negative ("empty sidewalk") → **snapshot declined**; scan offset chosen |
| 14:56:10 | **Look 2** (renderMs 406,906, bearing 155°): Agnes CONFIRMED — "Standing on the sidewalk in front of the left window display" → **snapshot fired** |
| 15:00:09 | Snapshot persisted (record below) |
| 15:00:30 | Mission end: looks fired 2, snapshots kept 1, declined 1 |

The operator's own read of both frames agrees with the VLM both times:
`../agent-look-01.png` shows the Tea House front with no figure;
`../agent-look-02.png` and the kept snapshot show Mira — the maid-outfit
resident — standing on the sidewalk in front of the left window, left of
the Tea House door.

## The kept snapshot

- File: `../snapshots/test-agent-1-20261110T150009Z-001.png`
  (145,619 bytes, sha256
  `407b1cb0ab19d725dae920ac5e3d505e877a7da6025b8a92de05d97874614e13`);
  sidecar record alongside it (`….png.json`).
- Pose: pos [-26.19, 0.2, -63.96], heading 155°, district "Sunstone
  Bazaar", nearest place shop-102 "Matchmaker's Tea House" at 8.62 m.
  Mira's published position is 6.46 m from that vantage at bearing ~184° —
  ~29° off the faced heading, inside the ~43° horizontal half-FOV, left of
  centre. In the frame she stands left of centre, in front of the left
  window, left of the door — exactly where the data-side geometry puts her.
- Disclosure: the kept snapshot is a FRESH capture at the confirmed pose
  (renderMs 234,479), not the identical pixels the VLM judged; the judged
  frame is `../agent-look-02.png`. Mira is a static resident and the pose
  is identical, so the two frames show the same composition.

## Persistence

- Local: `../snapshots/` PNG + sidecar; local sha256 == record sha256
  (recomputed after the run).
- R2: bucket `verse-assets`, key
  `snapshots/test-agent-1/test-agent-1-20261110T150009Z-001.png`. PUT
  returned HTTP 200; the service's in-flow GET-back verified bytes + sha256
  (`r2Verified: true`), and an independent post-reboot GET-back
  (`../r2_verify.py`) re-verified: 145,619 bytes, identical sha256.
- Index: `../index.jsonl` line 1 carries the full record — the
  proto-debrief queue's first entry.
