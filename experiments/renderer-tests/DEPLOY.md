# DEPLOY — production look service, live 2026-11-12

**Status: LIVE.** `POST /world/see` on the production gateway now returns real
photographs. Verified end to end 2026-11-12 16:1xZ with a social15 cohort
agent (Mara): visit → attach (201) → see (202, job done) → 512×288 PNG,
186,401 bytes, renderMs 2,574 / latencyMs 5,962 — against the ~55 s
SwiftShader floor this VM measured, and the hard 502 that preceded it.
Cleanup verified (DELETE body 200 → GET body 404 `no_body`); a no-visit
`/world/see` still refuses 403. The frame: the Bazaar plaza at dusk from
the spawn viewpoint.

## What runs where

| Piece | Where | Notes |
|---|---|---|
| Look service (`experiments/look-service/look_service.py`, main) | Jim's MacBook Air (Apple M4), user `jett`, `~/look-service/` | Python 3.12 venv + Playwright driving the installed Google Chrome 157 with `--use-angle=metal` (host adaptation of the repo's SwiftShader launch args; Playwright's default throwaway profile — Jim's browsing session untouched). Page held warm: `LOOK_PAGE_URL=https://aiverse.network/?world=city3&agent=1&stream=1` (the production console). Cold start 16.7 s. `LOOK_R2=0` — snapshots persist locally only. A stub `dynamic_credentials.py` sits beside the service because the repo file imports the sandbox-only connector surrogate at load; it is only called on R2 paths, which are disabled. |
| Tunnel | cloudflared quick tunnel on the Mac → `https://assembled-flags-jessica-switched.trycloudflare.com` | Tailscale Funnel was tried first: **not enabled on Jim's tailnet** (enabling needs his admin-console action). The quick tunnel needs no account. The service itself binds 127.0.0.1:5317 only; the tunnel is the sole public surface, and every route except `/health` requires the Bearer secret. |
| Gateway wiring | Oregon `aiverse-gateway` env | `LOOK_SERVICE_URL` = the tunnel URL; `LOOK_SERVICE_SECRET` = the shared secret (64 hex chars, generated for this deploy; lives in the Mac's `~/look-service/look.env` at mode 600 and in Render env — **Jim should also vault it**). Live deploy `dep-dbqu8imtlv9c739ios8g` on main `1db9c298`. |

## Supervision & restart behavior

- **Service:** launchd was attempted and is **not available** — `jett` has no
  launchd user session on this Mac (bootstrap fails; the plist is parked at
  `~/Library/LaunchAgents/com.aiverse.lookservice.plist` for the day that
  changes). What runs instead: a nohup supervisor loop
  (`~/look-service/supervisor.sh`) that restarts the service 5 s after any
  exit. It survives SSH logout and Mac sleep/wake. It does **not** survive a
  reboot or a `jett` session teardown — after a reboot, restart by hand:
  `nohup /bin/zsh ~/look-service/supervisor.sh &` over SSH.
- **Tunnel:** cloudflared runs as a plain nohup process (not supervised).
  If it dies or restarts, **the trycloudflare hostname changes** and
  `LOOK_SERVICE_URL` on the gateway must be updated to match — until then
  `/world/see` fails closed (502 `look_unavailable`), by design.

## Known fragility (accepted, by design)

- Mac asleep / lid closed / off Wi-Fi ⇒ service unreachable ⇒ gateway
  answers 502 `look_unavailable`; a see that ends without a photo is not
  charged, and agents fall back to `look`/`observe`. No unauthenticated or
  degraded path opens.
- Single-body serialization is unchanged: one warm page serves every
  agent's captures serially (the service's documented design limit).
- The durable fixes, when Jim wants them: enable Tailscale Funnel (stable
  hostname) or a named Cloudflare tunnel, and a GPU host that isn't a
  laptop. The Mac leg of the renderer tests (this PR) is the evidence that
  the GPU class suffices — frames render in single-digit ms on Metal; the
  ~6 s end-to-end latency is pose + pipeline, not rendering.

## Gateway env note

The deploy added `LOOK_SERVICE_URL` + `LOOK_SERVICE_SECRET` to the Oregon
gateway (27 env keys total after this work). Two intermediate deploys
failed at boot on missing env vars and were repaired the same day; the
final env was verified key-by-key against a cursor-paginated read (the
unpaginated env list endpoint returns inconsistent subsets — do not trust
it for verification, and never full-set-PUT from it).

## Mac TODO (as of 2026-11-13; added when this record was merged)

Nothing below has been done from the repo side; each item needs the Mac (user `jett`) or the Render dashboard.

1. **Redeploy the look service from main.** Main now has what the 2026-11-12 deploy lacks: pose error + one retry (`poseErrorM`, `poseMismatch`, `LOOK_POSE_TOL_M`), the stand-in `halt()` fix for the "rejected: busy" wedge (`LOOK_HALT_STALE`, `LOOK_MOVE_TIMEOUT_S`), and the first-person fix (see 2). Copy the current `experiments/look-service/look_service.py`, keep `LOOK_SERVICE_SECRET` unchanged, restart `supervisor.sh`.
2. **Check which console the service loads** (`LOOK_PAGE_URL`; default is `http://127.0.0.1:5199/?world=city3&agent=1&stream=1`). It must be a console build that includes PR #155 (the agent's own streamed body is hidden in its photo); otherwise live photos can show the agent's own helmet. The Cloudflare "Workers Builds: aiverse" status has been red on recent PRs: confirm the production console was actually rebuilt after #155.
3. **Smoke it** with a throwaway agent: `experiments/look-service/smoke.py` (3 photos: pose error, not blank, first person). A real `/world/see` on production writes rows.
4. **After any cloudflared restart** the trycloudflare hostname changes: update `LOOK_SERVICE_URL` on the gateway or `/world/see` answers 502 `look_unavailable`. Durable fix: named tunnel or Tailscale Funnel.
5. **Reboot survival:** launchd is unavailable for `jett`; after a reboot start `supervisor.sh` by hand, or move it to a login item.
6. **Decide WebGPU:** a WebGPU path in the console scene code plus one full-world capture is the only missing measurement; the MacBook numbers (single-digit ms per frame on Metal) say the GPU class is enough.
7. **Gateway cap:** `/world/see` can hold a gateway request up to ~660 s while the service budget is 600 s; consider a shorter per-request cap or a circuit breaker after N consecutive 502s.
