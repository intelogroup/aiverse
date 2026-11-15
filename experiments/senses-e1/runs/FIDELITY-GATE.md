# E1 pilot on the DEV WAY — fidelity gate outcome (2026-11-14)

**The dev way works. The pilot did NOT run — stopped at the fidelity
gate + smoke, on evidence below. Spend so far: $0.000222 (6 ledger
entries, all from the one A2 smoke run; every probe was scripted and
made no brain calls).**

## The dev way (what was built)

Local stack, re-creatable with `dev/dev_up.sh` (down: `dev/dev_down.sh`):
scratch Postgres 16 :5434 (db `aiverse_test` — the only DB name the
gateway's NODE_ENV=test guard allows) + Redis 7.2.5 :6379 + sim
(apps/sim) :3020 + gateway :3100 from the aiverse-test worktree at
main `4ca120d5`. A scripted TEST OWNER (`harness/devowner.py`) plays
the owner's role through the real APIs — register owner (once,
credentials only in `.secrets/devowner.json`, 0600), then per run:
register fresh agent → `POST /owners/agents/claim` → stop the
starter visit → `POST /owners/agents/:id/visits` {10080 min,
100000 actions}. Production untouched; no repo changes. Runtime
state lives in /tmp (the VM's uid mapping gives the postgres
`nobody` user no access under /home, and /tmp is wiped on VM
restarts — the scripts rebuild runtime state from durable workspace
sources: `~/workspace/.postgres` and the Redis build cached in
`dev/stack/`).

Step-0 findings: no DEV_/TEST_MODE/ALLOW_UNCLAIMED affordance exists.
The only dev-flavored flag is `AIVERSE_DEV_FAST_BOOTSTRAP` (native
refill rate). The gateway mounts `/world/*` only with
`AIVERSE_WORLD_MODE=1` + `SIM_URL` + `SIM_INTERNAL_SECRET` (≥32
chars) — the world is a separate sim service, not in-process.
Email verification is not required when NODE_ENV != production.

## Fidelity evidence — the local world IS the production world

Scripted rehearsal + probes (`runs/evidence/`):

- `/world/map`: **158 places** — exact production count.
- Tea resolution: map carries four "Today's Tea" decoys; the sim
  resolves the bare query `"tea"` → **shop-102, "Matchmaker's Tea
  House" (room `tea`)**, exactly as the Nov 10 production flight.
  (The harness's client-side resolver originally picked a decoy;
  fixed to prefer room == "tea" — see harness changes.)
- No plaza-named place exists (kinds: 80 stall, 77 shopfront,
  1 hall). The plan's "plaza drop point" = the spawn area; spawn is
  deterministic (5.68, 10.57), nearest place stall-40. The runner
  now falls back to the spawn-nearest place.
- Navmesh: go_to settles `arrived` (spawn → tea 78 s at ~1.2 m/s
  walk); return leg settles `arrived` at stall-40.
- The world's only interactable, **tea-radio**, exists (stand point
  [-20.55, -75.9], counter box x[-21.96,-21.04] z[-76.34,-75.46])
  and is perceivable (0.5–2.3 m in scene from inside the room).

## Why the pilot stopped anyway — the task, not the world

Two arm-independent constants consume the run, and one geometry
fact gates the interact:

1. **enter times out at ~123 s** (4/5 observed enters; the act's
   ~120 s cap) — the body does end up inside, but the runner waits
   for settle, so go (78 s) + enter (123 s) burn **~201 s of the
   300 s budget before the agent can act inside**. One early probe
   saw a clean 74 s enter; the timeout is the common case.
2. **The radio interact blocks from every natural approach.** The
   stand point sits 0.49 m east of the counter's collision face;
   the movement machine's stall rule (no progress 2.5 s → blocked)
   fires on every approach that must round the counter: from the
   door (stuck 1.1 m out, twice, identical geometry), from the room
   center (1.8 m out), from due north (2.3 m out). It **succeeds
   only from the counter's east side** (probe 4: staged at
   (-19.5,-76.4) → `done`, radio on, 6 s). The runner's GUIDE does
   not offer the sim's point-form go_to, so a brain has no reliable
   way to stage east.
3. **The A2 smoke confirms it end-to-end** (real DeepSeek brain,
   run `e1-a2-smoke-01-5beb16`): go_to arrived → enter timeout →
   interact tea-radio blocked → retry blocked at the same 1.1 m
   point → gave up and headed home → **failed_deadline at 300.03 s,
   6 turns**. The brain behaved sensibly throughout.

Projected over 40 runs: completion ≈ 0 in every arm — the
completion contrast (H1a) is floor-bound by world friction that is
identical across arms, and ~3.3 h of wall time would buy a null the
gate already proves structurally. That is the gate doing its job:
the pilot was not run on a *different* world — it was not run on a
task whose fixed step is not reliably performable as choreographed.

## Retune options (parent/Jim decision — any reopens the pilot)

- **(a) Deadline 360 s** — the plan's own §3 default ("tuned in
  pilot"). Fixes the return-leg arithmetic, not the interact.
- **(b) GUIDE gains point-form go_to/run_to** (the sim's wire type
  supports `point`; the public docs don't advertise it) and/or the
  task text hints the agent may reposition inside the room. Makes
  the eastern staging discoverable; with (a), completion becomes
  genuinely possible.
- **(c) Swap the fixed interaction** to a tea-house `sit` (seats
  exist in the room) — changes the plan's task definition.
- **(d) Run anyway** for the non-completion metrics (hurry-switch,
  deadline-miss distance). The smoke says these are thin: 6 turns,
  no run_to chosen, most of every run spent inside two movement
  acts.

Recommendation: (a) + (b), then one re-smoke, then the pilot.

## Harness changes made for the dev way (75/75 tests green)

- `world.py`: gateway base URL configurable (`AIVERSE_GATEWAY_BASE`
  env / `base_url` param; production default unchanged);
  `resolve_places` tea preference (room == "tea" → "tea house"
  name → first match).
- `devowner.py` (new): the scripted test owner above. Claim calls
  present per-provision TEST-NET-2 x-forwarded-for (the claim route
  buckets 5/15 min per source IP; rightmost-XFF keying is the
  gateway's own rule off-Render — same pattern as its CI suites).
- `e1.py`: `--dev-local` mode (fresh claimed agent per run via the
  test owner; mutually exclusive with `--reuse-agent`); plaza
  fallback to the spawn-nearest place (`plaza_basis` recorded in
  every footer); task text now says ENTER and find the Radio;
  the shopfront interactable-feasibility kill removed (perception
  is cone-gated — not seeing the radio proves nothing; the
  rehearsal above is the feasibility proof).
- Tests: +8 (devowner lifecycle/claim shape/secret hygiene, e1
  dev-local provision/teardown, base-URL override, tea preference,
  no-interactable semantics). Suite: 67 → 75, all green.

## State after this report

Stack torn down via `dev/dev_down.sh` (gateway/sim/Postgres/Redis
stopped; logs, run files, scripts, and the Redis cache kept).
Re-boot: `dev/dev_up.sh`, then
`AIVERSE_GATEWAY_BASE=http://localhost:3100 python3 harness/e1.py
pilot --dev-local` runs the 40-run pilot the moment a retune is
chosen. Ledger stands at $0.000222 of the $1.00 cap.
