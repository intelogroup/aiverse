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

Inspect a GLB's JSON in Python:
```python
import json,struct; f=open(p,"rb").read(); n=struct.unpack("<I",f[12:16])[0]; j=json.loads(f[20:20+n])
print(j.get("extensionsUsed"), [m["name"] for m in j["materials"] if m.get("doubleSided")], [x["name"] for x in j["nodes"]][:20])
```
