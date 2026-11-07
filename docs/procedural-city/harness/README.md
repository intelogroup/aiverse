# Harnesses (throwaway, but they caught real bugs)

Setup once (outside the repo tree, e.g. a scratch dir):
```
mkdir spike && cd spike && npm init -y >/dev/null && npm i three@0.170.0 playwright   # playwright is global in the container: ln -s /opt/node22/lib/node_modules/playwright node_modules/playwright
ln -s <repo>/apps/console/public/assets assets
ln -s <repo>/tools/city3/out city3out            # city.html loads /city3out/world-city3.glb
bun build <repo>/apps/console/src/features/world/bodyController.ts --outfile=bodyController.js --target=browser   # for tv4/turn_verify
cp <repo>/docs/procedural-city/harness/* .
```
| File | Use |
|---|---|
| `city.html` + `city.mjs` | Load a GLB (meshopt) in plain three, render named views to PNG. `Q="v=<urlencoded JSON of {name:[[cam],[target]]}>" PFX=name node city.mjs`; extras: `cut=1`, `extra=<glb>`, `anchors=1`, `hide=ObjName`, `glb=<name>`, `aa=0`, `sh=0` |
| `rooms_check.mjs` | Real console: buttons, requests at load/after, cutaway screenshots (`?world=city3`, needs `vite --port 5183`) |
| `stream_rooms.mjs` | 100-cycle streaming memory test over all rooms (`CYCLES=100 node stream_rooms.mjs`, background it) |
| `tv4.html/.mjs`, `turn_verify.html/.mjs` | Turn-clip planting and pelvis-vs-heading checks |
| `agora_rev.mjs` | Live Agora reversal with Embody (`?embody=1&bodyDebug=1`), 480x320 viewport |
| `skin.html/.mjs` | CPU cost of N skinned characters (mixer + submit) |
| `gait_stride.mjs` | Headless (node + three, textures stripped): Walk/Run stance-foot speed, foot heights, touchdown phases, hips drift. Copy into `apps/console/` (ESM needs its `three`), `node gait_stride.mjs public/assets/cast-summer.glb 0.02` (arg 2 = contact band; calibrate on Walk) |
| `gait_slip.mjs` | SUPERSEDED by `gait_full.mjs` (joint-based, skipped the hips guard, stale Summer constants) |
| `gait_full.mjs` | Headless full CastFigure stack (imports the shipped `grounding.ts`/`gait.ts`): planted-sole skate of skinned vertices on the floor, contact share, lowest vertex. `IK=1` adds the runtime foot lock (`footLock.ts`), `GLB=` swaps the file, `TRACE=f.csv` writes world Z of each foot's floor-touching vertices per frame (plot it: flat steps = planted); `MODE=before` replays the pre-2026-11-07 path; `IDLE=Idle` plays the old marching clip (default `IdleLong`). Copy into `apps/console/`, `node --experimental-strip-types gait_full.mjs summer\|remy` (`VS=1.3,2.7`, `FLOOR=0.6`) |
| `contact_probe.mjs` / `contact_probe.html` | Contact-pose audit: rig proportions, per-foot stance interval, stance speed, contact-point straightness, mid-swing clearance (CSV for plotting); the html renders 6 contact-phase poses with ankle / toe-base / toe-tip markers. Copy into `apps/console/`; see 10-walker.md "Contact-pose audit" |
| `ts_resolve.mjs` | Node loader hook: extensionless relative imports resolve to `.ts` (footLock.ts -> grounding.ts). `node --experimental-strip-types --import ./ts_resolve.mjs gait_full.mjs ...` |
| `gait_probe.html` | Filmstrip of 7 gait phases, side view, red floor line, lowest vertex per frame. Copy into `apps/console/`, serve with vite, `/gait_probe.html?body=summer&mode=before&v=1.3` (`&ik=1` = with the foot lock) (`&idle=Idle` for the old clip) |
| `walkshots.cjs` | Real console City 3 walker: follow-cam screenshot sequences of idle/walk/run/strafe/backward (`NODE_PATH=/opt/node22/lib/node_modules node walkshots.cjs <vite port> <outdir> [phase,...]`) |

Inspect a GLB's JSON in Python:
```python
import json,struct; f=open(p,"rb").read(); n=struct.unpack("<I",f[12:16])[0]; j=json.loads(f[20:20+n])
print(j.get("extensionsUsed"), [m["name"] for m in j["materials"] if m.get("doubleSided")], [x["name"] for x in j["nodes"]][:20])
```
