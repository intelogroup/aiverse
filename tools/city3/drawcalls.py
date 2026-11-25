"""Measure real per-frame draw calls and triangles in the running world.

WHY THIS EXISTS: apps/console/tests/asset-budgets.ts gates GLB bytes and triangles only.
Neither predicts frame cost -- src/features/world/bazaarBatch.ts merges props by family and
spatial cell at runtime, and districtTree.hideLegacyWater() hides the legacy water/sea
meshes, so a static GLB inspection cannot tell you the draw count. This instruments
WebGL2 drawElements/drawArrays(/Instanced) via add_init_script -- no app changes -- counts
per animation frame, and saves screenshots of each orbit/zoom state.

Requires the dev server with LOCAL assets (origin/main otherwise resolves world GLBs to
https://assets.aiverse.network, which CORS-blocks at localhost and yields a blank canvas):

    VITE_ASSET_BASE="" bunx vite --port 5183
    python3 tools/city3/drawcalls.py            # URL=... OUT=... to override

Reported: draws/frame, tris/frame (shadow + main pass both counted), page errors.
"""
import json, os, sys, time
from playwright.sync_api import sync_playwright

URL = os.environ.get("URL", "http://127.0.0.1:5183/?world=city3")
OUT = os.environ.get("OUT", "/Users/kalinovdameus/Developer/aiverse-landscape/tools/city3/out/browser")
os.makedirs(OUT, exist_ok=True)
W, H = 1440, 900

HOOK = r"""
window.__stats = {draws:0, tris:0, points:0};
window.__frames = 0;
(function raf(){ window.__frames++; requestAnimationFrame(raf); })();
(function(){
  const p = WebGL2RenderingContext.prototype;
  function wrap(name){
    const f = p[name]; if (!f) return;
    p[name] = function(...a){
      try{
        window.__stats.draws++;
        const count = a[1]|0;
        const inst = name.indexOf('Instanced') >= 0 ? (a[4]|0) : 1;
        window.__stats.tris += Math.floor(count/3) * (inst || 1);
      }catch(e){}
      return f.apply(this, a);
    };
  }
  ['drawElements','drawArrays','drawElementsInstanced','drawArraysInstanced'].forEach(wrap);
})();
"""

def stats(page):
    return page.evaluate("() => ({...window.__stats, frames: window.__frames})")

def delta(a, b):
    return {"draws_frame": (b["draws"] - a["draws"]) / max(1, b["frames"] - a["frames"]),
            "tris_frame": (b["tris"] - a["tris"]) / max(1, b["frames"] - a["frames"]),
            "frames": b["frames"] - a["frames"]}

with sync_playwright() as pw:
    browser = pw.chromium.launch(args=[
        "--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu",
        "--enable-unsafe-swiftshader",
    ])
    ctx = browser.new_context(viewport={"width": W, "height": H}, device_scale_factor=1)
    ctx.add_init_script(HOOK)
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append("console:" + m.type + ":" + m.text[:160])
            if m.type in ("error",) else None)
    page.on("pageerror", lambda e: errors.append("pageerror:" + str(e)[:160]))

    page.goto(URL, wait_until="domcontentloaded", timeout=120000)
    print("navigated", flush=True)

    # WebGL actually alive?
    gl = page.evaluate("""() => {
      const c = document.createElement('canvas');
      const g = c.getContext('webgl2');
      if (!g) return 'NO WEBGL2';
      const d = g.getExtension('WEBGL_debug_renderer_info');
      return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : 'webgl2 ok (renderer masked)';
    }""")
    print("WEBGL:", gl, flush=True)

    # wait for the world to stream in
    t0 = time.time()
    last = stats(page)
    while time.time() - t0 < 150:
        time.sleep(5)
        s = stats(page)
        if s["draws"] > last["draws"]:
            last = s
            print("loading... draws=%d frames=%d" % (s["draws"], s["frames"]), flush=True)
        if s["frames"] > 60 and s["draws"] > 200:
            break

    a = stats(page)
    time.sleep(4)
    b = stats(page)
    print("STEADY", json.dumps(delta(a, b)), flush=True)

    shots = []
    def shot(name):
        p = os.path.join(OUT, "world_%s.png" % name)
        page.screenshot(path=p)
        shots.append(p)
        print("SHOT", name, flush=True)

    shot("01_spawn")

    # orbit: drag across the canvas
    for i, (dx, dy) in enumerate([(320, 0), (-500, -140), (260, 180)]):
        page.mouse.move(W // 2, H // 2)
        page.mouse.down()
        for k in range(12):
            page.mouse.move(W // 2 + dx * (k + 1) / 12, H // 2 + dy * (k + 1) / 12)
            time.sleep(0.02)
        page.mouse.up()
        time.sleep(1.5)
        shot("02_orbit%d" % (i + 1))

    # zoom in (wheel) x3
    for i in range(3):
        page.mouse.move(W // 2, H // 2)
        page.mouse.wheel(0, -600)
        time.sleep(1.2)
        shot("03_zoom%d" % (i + 1))

    a = stats(page); time.sleep(4); b = stats(page)
    print("AFTER_ZOOM", json.dumps(delta(a, b)), flush=True)

    print("ERRORS", json.dumps(errors[:12]), flush=True)
    print("SHOTS", json.dumps(shots), flush=True)
    browser.close()
print("SWEEP OK")
