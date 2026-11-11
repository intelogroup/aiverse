# Look Service — STATUS

Commission: Jim 2026-11-10 08:43 — build + test agent look/snapshot service v1
(experiments-grade). Agents navigate on data; a snapshot is an agent DECISION
(event-fired, never periodic).

## Design (settled in recon)
- Page: production console world via the rigs' proven path — Vite dev server
  (port 5199) serving ~/workspace/.build-tmp/ws-main (main @ PR #78 merge
  549c1b3; world-city3.glb is byte-size-identical to production's
  44,653,948 B). URL ?world=city3&agent=1 mounts ScoutAgent (Remy body),
  exposing window.__scout {ready, snapshot, look, act, places}.
- Capture: __scout.look() = ScoutVision offscreen render target at the body's
  head (512x288 PNG + depth array in metres). NOT a screen capture.
- Pose from request: service moves the body with act go_to(point) + face
  (headingDeg) before capturing; pose echo = __scout.snapshot() after.
  Pitch: unsupported by the head rig (level camera) — accepted in the API,
  reported as 0. Honest gap, named.
- Service: Python asyncio + Playwright (chromium-1243, SwiftShader args from
  egg_hunt_runner_v2) + hand-rolled asyncio HTTP server on 127.0.0.1:5317.
  Endpoints: POST /look, POST /snapshot, POST /move, GET /health.
  Captures serialize (page main thread renders; v2 rig lesson).
- Snapshot store: local snapshots/ + R2 verse-assets snapshots/<agent>/<file>
  via management-API object route (pattern: r2-staging/stage_upload.py,
  conn custom.cloudflare-aiverse) + GET-back sha verify + index.jsonl.
- Test agent: data-only navigation over city3-places.json (published).
  Target: Mira, resident figure at (-26.6, -70.4), street-side left of the
  Tea House door (place shop-102, stand (-25.0,-72.5), door (-22.92,-72.5)).
  Decisions: waypoint arrivals + scan steps fire looks; Agnes 2.5 Flash
  (conn custom.agnes-ai) confirms target in frame; ONLY a confirm triggers
  /snapshot. All decisions logged with UTC timestamps. No timers/periodics.
- node_modules: ws-main has none; package.json manifests identical to
  world-sweep/work (which is installed) -> symlink its node_modules in.
  (bun.lock differs; console manifests identical, ranges satisfied.)

## Progress
- [x] Recon: rig pattern, scout API, capture mechanics, R2 + Agnes patterns
- [x] Vite up (5199, ws-main tree, node_modules symlinked from world-sweep/work)
      + Xvfb :99 + page warm: cold start 76,069 ms (launch->ready),
      spawn (5.68, 0.2, 10.57), 0 pageerrors. Service HTTP on 127.0.0.1:5317.
- [x] look_service.py written (look/move/snapshot/health)
- [x] Smoke /look: attempts 1-2 FAILED on the 150 s service timeout
      (in-page capture still running each time; abandoned evaluates queue
      in-page). Service restarted with 600 s capture timeout, clean page.
      Attempt 3 SUCCEEDED: renderMs 394,078 (6.6 min — first capture pays
      vision-rig shader compiles; box load ~4.4 on 1.5 shared CPUs),
      poseMs 892, PNG 217,623 B. Frame verified by eye: Sunstone Bazaar
      plaza from head height at spawn — real world, correct pose.
      Depth summary sane (validFrac .756, median 12.3 m).
- [x] Latency run DONE: 12/12 ok (latency.json). renderMs: first 437,104
      (one-time compile outlier), then 30,182-81,211 — median 54,900
      all-12; steady-state (excl. first) median ~55 s, max 81 s.
      Cold starts measured: 76,069 / 69,004 / 70,254 ms.
- [x] Locomotion diagnosed + fixed by vantage choice: go_to/run_to work
      (probe_move.py: walk 12 m arrived 13.4 s; run arrived 23.5 s).
      The Tea House interior STAND (-25,-72.5) is NOT routable —
      executor settles "blocked: no safe route" from two starts
      (planner groundY gate vs raised interior doorstep). Street
      vantages ~6 m from Mira are routable (probe2: arrived).
      Also fixed a service bug: face outcome overwrote move outcome in
      /move responses; per-step outcomes + full pose diagnostics now.
- [x] Mission run 2 COMPLETE (agent-decisions.jsonl): looks fired 2,
      snapshots kept 1, declined 1. Look 1: Mira not yet streamed in
      (resident GLB pipeline lag under load) — VLM negative, declined.
      Look 2 (bearing 155): VLM CONFIRMED Mira ("standing on the
      sidewalk in front of the left window display"); my own read of
      look-02 AND of the kept snapshot agrees. Snapshot record:
      snapshots/test-agent-1-20261110T150009Z-001.png, 145,619 B,
      sha256 407b1cb0..., pose [-26.19,0.2,-63.96] hdg 155 (geometry
      checks: Mira 6.46 m @ ~184 deg -> ~29 deg off-axis, left of
      centre in frame, as shown). R2 PUT 200 + in-flow GET-back
      verified; INDEPENDENT post-reboot GET-back also verified
      (r2_verify.py: bytes+sha identical). index.jsonl has its line.
- [x] LOOK-SERVICE-REPORT.md written (latency table, decision excerpt,
      correctness, persistence, failure honesty).
- [x] AMENDMENT (Jim 09:48): evidence bar MET -> PR OPENED, not merged.
      Branch tmp/look-service from main 5ccd906e (main had not moved),
      commit 6ff72c06, 16 files under experiments/look-service/ —
      compare-verified: remote diff is exactly those 16 additions.
      PR #90: https://github.com/intelogroup/aiverse/pull/90
      (publish_pr.py is the publish script; body= keyword discipline.)
- [x] LANE COMPLETE. Stack left DOWN after the 15:00Z VM reboot
  (service/Vite/Xvfb not relaunched — mission was already complete;
  relaunch steps are in LOOK-SERVICE-REPORT.md gap 7).
- NOTE: VM rebooted ~15:00Z just after mission end; service/Vite/Xvfb
  stack is DOWN (nothing lost). Relaunch commands in the report.
- [ ] test_agent.py mission run (decision log)
- [ ] Snapshot persisted local + R2 + verified, index line
- [ ] LOOK-SERVICE-REPORT.md

## State
- services running detached: Xvfb :99, vite :5199, look_service.py (pid in
  service.log stream). Health: curl 127.0.0.1:5317/health
- next: read smoke2 result; if look() completes slowly-but-surely, proceed
  (report latency as measured); if it wedges, diagnose in-page (capture
  contention with the 1 s heartbeat invalidate is the named suspect from
  the ScoutAgent header).
