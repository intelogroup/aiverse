"""One command that runs every City 3 world gate and writes a report.

    python3 tools/city3/world_gate.py [--uv] [--render] [--fast]
                                      [--report out/world-gate.json]

Gates, in order of cost:
  dims       kit spec vs shipped GLB, transform-aware            (python, 0.2 s)
  placement  layout JSONs vs library bounds, pinned baseline      (python, 1.2 s)
  clips      animation structure across cast GLBs                 (python, 0.6 s)
  images     embedded images, KTX2 honesty, duplicate payloads    (python, 2.8 s)
  uv         per-triangle texel density, unmapped faces           (Blender, ~2 s)
  render     measured-framing Workbench views + contact sheet     (Blender, opt-in)

`--uv` adds the Blender UV pass (off by default so the runner works on a box
without Blender); `--render` adds preview_multi + sheet.py for one asset.
`--fast` skips images (the only gate that reads every byte of a 64 MB GLB).

Exit 1 when any gate fails. The report records each gate's verdict, wall time and
the last line of its own output, so a CI log and a JSON artefact agree.
"""
import json
import os
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(f"{HERE}/../..")
ASSETS = f"{ROOT}/apps/console/public/assets"
REPORT = f"{HERE}/out/world-gate.json"


def blender():
    for p in (os.environ.get("BLENDER"), "/opt/homebrew/bin/blender",
              "/Applications/Blender.app/Contents/MacOS/Blender",
              shutil.which("blender")):
        if p and os.path.exists(p):
            return p
    return None


def run(name, cmd, env=None):
    t0 = time.time()
    p = subprocess.run(cmd, cwd=ROOT, capture_output=True, text=True,
                       env={**os.environ, **(env or {})})
    out = (p.stdout or "") + (p.stderr or "")
    lines = [ln for ln in out.strip().splitlines()
             if ln.strip() and not ln.startswith(("Blender 5", "Read prefs"))
             and "Warning" not in ln and "warning" not in ln]
    verdict = [ln for ln in lines if ln.lstrip().startswith(
        ("ALL OK", "FAILED", "FAIL", "SHEET", "ok ", "  ok "))]
    return dict(gate=name, cmd=" ".join(cmd), ok=p.returncode == 0,
                rc=p.returncode, secs=round(time.time() - t0, 2),
                last=(verdict[-1] if verdict else (lines[-1] if lines else "")).strip(),
                fails=[ln for ln in lines if ln.startswith(("FAIL", "  FAIL"))][:6])


def main(argv):
    py = sys.executable
    bl = blender()
    STRICT = ["--strict"] if "--strict" in argv else []
    gates = [
        ("dims", [py, f"{HERE}/dims_gate.py"], None),
        ("dims-lib", [py, f"{HERE}/dims_gate.py", f"{ASSETS}/world-city3-library.glb",
                      f"--spec={HERE}/out/world-library-dims.json"], None),
        ("placement", [py, f"{HERE}/placement_audit.py"] + STRICT, None),
        ("clips", [py, f"{HERE}/clip_audit.py",
                   f"--baseline={HERE}/out/clips-baseline.json"], None),
        ("stalls", [py, f"{HERE}/stall_audit.py", "--check",
                    f"--baseline={HERE}/out/stall-baseline.json"], None),
        ("degenerate", [py, f"{HERE}/bridge_drop_degenerate.py",
                        f"{ASSETS}/world-city3.glb", "-", "--check"], None),
        ("eaves", [py, f"{HERE}/bridge_eaves.py",
                   f"{ASSETS}/world-city3.glb", "-", "--check"], None),
        ("trees", [py, f"{HERE}/bridge_real_trees.py",
                   f"{ASSETS}/world-city3.glb", "--check"], None),
    ]
    if "--fast" not in argv:
        gates.append(("images", [py, f"{HERE}/unpack_sheet.py",
                                 f"{ASSETS}/world-city3.glb",
                                 f"{HERE}/out/world-images.png"], None))
    if "--uv" in argv:
        if not bl:
            print("SKIP uv: no Blender found (set BLENDER=...)")
        else:
            gates.append(("uv", [bl, "-b", "--factory-startup", "--python",
                                 f"{HERE}/uv_stats.py", "--",
                                 f"{ASSETS}/interior-kit.glb"] +
                          ([f"--baseline={HERE}/out/uv-baseline.json"]
                           if os.path.exists(f"{HERE}/out/uv-baseline.json") else []),
                          None))
    if "--render" in argv:
        if not bl:
            print("SKIP render: no Blender found")
        else:
            vout = f"{HERE}/out/gate_render"
            gates.append(("render", [bl, "-b", "--factory-startup", "--python",
                                     f"{HERE}/preview_multi.py", "--",
                                     f"{ASSETS}/interior-kit.glb", vout,
                                     "front", "threequarter"],
                          {"ENGINE": "BLENDER_WORKBENCH", "RESX": "480", "RESY": "360"}))
            gates.append(("sheet", [py, f"{HERE}/sheet.py", vout], None))

    print(f"WORLD GATE  blender={bl or '-'}  gates={len(gates)}")
    results = []
    for name, cmd, env in gates:
        r = run(name, cmd, env)
        results.append(r)
        print(f"  {'ok  ' if r['ok'] else 'FAIL'} {name:10s} {r['secs']:6.2f}s  {r['last'][:96]}")
        for f in r["fails"]:
            print(f"       {f[:110]}")

    bad = [r for r in results if not r["ok"]]
    doc = dict(at=time.strftime("%Y-%m-%dT%H:%M:%S"), blender=bl,
               ok=not bad, secs=round(sum(r["secs"] for r in results), 2), gates=results)
    os.makedirs(os.path.dirname(REPORT), exist_ok=True)
    with open(REPORT, "w") as f:
        json.dump(doc, f, indent=1)
    print(f"{'FAILED' if bad else 'ALL OK'}  {len(bad)}/{len(results)} gates  "
          f"total {doc['secs']} s  -> {os.path.relpath(REPORT, ROOT)}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main(sys.argv[1:])
