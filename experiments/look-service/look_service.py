#!/usr/bin/env python3
"""LOOK SERVICE — AIVerse agent look/snapshot service (production-hardened).

A warm headless Chromium (SwiftShader) holds the production console world
(Bazaar, City 3) loaded ONCE via the rigs' proven Vite path on :5199 with
?world=city3&agent=1, which mounts ScoutAgent and exposes window.__scout.
The warm page IS the passed pipeline verdict (egg-hunt optimization runs):
no cold page per look, ever — cold start is ~70 s and a first capture in a
fresh area pays minutes of shader work, so a look is a decision-fired
event, never a reflex.

POST /look     {agentId, position:[x,z], headingDeg, pitch?}
    Moves the agent's BODY to the requested pose (act go_to + face — the
    pose comes from the request, never from console session state), then
    captures from the body's head via __scout.look(): ScoutVision's
    offscreen render target, 512x288 PNG + depth array in metres.
    The oracle `scene` field of look() is DISCARDED inside this service —
    it never reaches a caller (sensorium charter: evidence, not answers).
POST /move     {agentId, position, headingDeg, mode} — locomotion only.
POST /snapshot {agentId, position, headingDeg, note} — a look that PERSISTS:
    PNG -> local snapshots/ + R2 verse-assets snapshots/<agentId>/<file>
    (management-API object route, GET-back sha256 verify) + index.jsonl.
GET  /health   (never authenticated; carries no agent data)

AUTH: when LOOK_SERVICE_SECRET is set (>= 32 chars), every route except
GET /health requires `Authorization: Bearer <secret>` (constant-time
compare) — the gateway's /world/see proxy is the only intended caller.
When it is unset the service runs in DEV MODE: it binds 127.0.0.1 only
and logs a loud warning. Never expose a dev-mode instance beyond loopback.

CONFIG (env, defaults = the proven local rig):
    LOOK_SERVICE_SECRET   shared secret (above); unset = dev mode
    LOOK_SERVICE_HOST     bind host (default 127.0.0.1)
    LOOK_SERVICE_PORT     bind port (default 5317)
    LOOK_PAGE_URL         console page to hold warm (default the :5199 rig)
    LOOK_R2_ACCOUNT       Cloudflare account for the snapshot store
    LOOK_R2_BUCKET        snapshot bucket (default verse-assets)
    LOOK_R2=0             disable R2 writes (snapshots persist locally only)

SINGLE-BODY SERIALIZATION (a design limit, not a bug): one Scout page =
one stand-in body. Every capture walks that body to the requested pose
first, and all captures serialize on one lock — the page's main thread
renders, and the v2 rig proved parallel captures wedge it. Serving N
agents concurrently takes N instances (or pages), never threads here.

Pitch is accepted but the head rig's camera is level: pitch is reported
as 0 / pitchSupported=false. Honest v1 gap.
"""
import asyncio, base64, hashlib, hmac, json, os, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request  # noqa: E402
from playwright.async_api import async_playwright  # noqa: E402

HERE = Path(__file__).parent
SNAP_DIR = HERE / "snapshots"
INDEX = HERE / "index.jsonl"
PAGE_URL = os.environ.get("LOOK_PAGE_URL", "http://127.0.0.1:5199/?world=city3&agent=1")
HTTP_HOST = os.environ.get("LOOK_SERVICE_HOST", "127.0.0.1")
HTTP_PORT = int(os.environ.get("LOOK_SERVICE_PORT", "5317"))
SECRET = os.environ.get("LOOK_SERVICE_SECRET", "")
AUTH_REQUIRED = len(SECRET) >= 32
R2_ENABLED = os.environ.get("LOOK_R2", "1") != "0"

ACCT = os.environ.get("LOOK_R2_ACCOUNT", "c33b1793391df60672de585ebdee3791")
BUCKET = os.environ.get("LOOK_R2_BUCKET", "verse-assets")
R2_BASE = f"https://api.cloudflare.com/client/v4/accounts/{ACCT}/r2/buckets/{BUCKET}/objects"
R2_CONN = "custom.cloudflare-aiverse"


def authorized(headers):
    """Constant-time bearer check. Dev mode (no/short secret) authorizes
    everything and says so at boot — loopback is the boundary there."""
    if not AUTH_REQUIRED:
        return True
    got = headers.get("authorization", "")
    if got.startswith("Bearer "):
        got = got[7:]
    return hmac.compare_digest(got, SECRET)


def utcnow():
    return datetime.now(timezone.utc)


def iso(ts=None):
    return (ts or utcnow()).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------- R2 store
class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a):
        raise RuntimeError("redirect refused")


OPENER = urllib.request.build_opener(NoRedirect())


def r2_put(key, data, content_type):
    req = urllib.request.Request(R2_BASE + "/" + key, data=data, method="PUT")
    req.add_header("Content-Type", content_type)
    add_surrogate_to_request(req, R2_CONN, allowed_hosts=["api.cloudflare.com"])
    with OPENER.open(req, timeout=120) as r:
        payload = json.loads(r.read())
        return r.status, payload.get("result", {})


def r2_get_sha(key):
    req = urllib.request.Request(R2_BASE + "/" + key, method="GET")
    add_surrogate_to_request(req, R2_CONN, allowed_hosts=["api.cloudflare.com"])
    h = hashlib.sha256(); n = 0
    with OPENER.open(req, timeout=120) as r:
        while True:
            chunk = r.read(1 << 20)
            if not chunk:
                break
            h.update(chunk); n += len(chunk)
    return n, h.hexdigest()


# ---------------------------------------------------------------- the page
class LookService:
    def __init__(self):
        self.lock = asyncio.Lock()
        self.page = None
        self.ready = False
        self.cold_start_ms = None
        self.warm_since = None
        self.looks_served = 0
        self.snapshots_kept = 0
        self.snap_seq = 0
        self.last_error = None

    async def start(self):
        t0 = time.time()
        self.pw = await async_playwright().start()
        self.browser = await self.pw.chromium.launch(args=[
            "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
            "--no-sandbox", "--disable-dev-shm-usage", "--mute-audio",
        ])
        self.page = await self.browser.new_page(viewport={"width": 640, "height": 360})
        self.page.on("pageerror", lambda e: print(f"[pageerror] {str(e)[:300]}", flush=True))
        self.page.on("console", lambda m: print(f"[console:{m.type}] {m.text[:200]}", flush=True)
                     if m.type in ("error",) else None)
        await self.page.goto(PAGE_URL)
        await self.page.wait_for_function(
            "window.__scout && window.__scout.ready()", timeout=300000)
        self.cold_start_ms = round((time.time() - t0) * 1000)
        self.warm_since = iso()
        self.ready = True
        snap = await self.snapshot()
        print(f"[service] READY cold_start_ms={self.cold_start_ms} spawn={snap and snap.get('pos')}", flush=True)

    async def snapshot(self):
        try:
            return await asyncio.wait_for(
                self.page.evaluate("window.__scout.snapshot()"), timeout=60)
        except Exception as e:
            self.last_error = f"snapshot: {type(e).__name__}: {e}"[:200]
            return None

    async def act(self, action, timeout_s):
        return await asyncio.wait_for(
            self.page.evaluate(
                """async (a) => {
                  const timeout = new Promise((res) => setTimeout(
                    () => res({ok:false, status:"harness-timeout",
                               snapshot: window.__scout.snapshot()}), %d));
                  return Promise.race([window.__scout.act(a), timeout]);
                }""" % int(timeout_s * 1000), action),
            timeout=timeout_s + 15)

    async def apply_pose(self, position, heading_deg, mode="walk"):
        """Move the body to the requested pose; return (pose_echo, pose_ms, outcomes)."""
        t0 = time.time()
        outcomes = {}
        snap = await self.snapshot()
        if position is not None and snap:
            cur = snap["pos"]
            dist = ((position[0] - cur[0]) ** 2 + (position[1] - cur[2]) ** 2) ** 0.5
            if dist > 0.4:
                act_type = "run_to" if mode == "run" else "go_to"
                timeout_s = min(600, 45 + dist * 3.0)
                res = await self.act(
                    {"type": act_type, "point": [position[0], position[1]]}, timeout_s)
                outcomes["move"] = {k: (res or {}).get(k) for k in ("ok", "status", "detail", "target")}
        if heading_deg is not None:
            res = await self.act({"type": "face", "headingDeg": heading_deg}, 30)
            outcomes["face"] = {k: (res or {}).get(k) for k in ("ok", "status", "detail")}
            # let the rendered body heading damp onto the faced heading
            await self.act({"type": "wait", "seconds": 1.2}, 15)
        snap = await self.snapshot()
        pose_ms = round((time.time() - t0) * 1000)
        pose = None
        if snap:
            pose = {"pos": snap["pos"], "headingDeg": snap["headingDeg"],
                    "bodyHeadingDeg": snap["bodyHeadingDeg"],
                    "groundY": snap["groundY"], "district": snap["district"],
                    "nearestPlace": snap["nearestPlace"],
                    "busy": snap["busy"], "currentAction": snap["currentAction"],
                    "speed": snap["speed"], "clip": snap["clip"],
                    "posture": snap["posture"], "routeLen": len(snap["route"])}
        return pose, pose_ms, outcomes

    def depth_summary(self, depth):
        if not depth or not depth.get("values"):
            return None
        vals = depth["values"]; w = depth["width"]; h = depth["height"]
        valid = sorted(v for v in vals if v and v > 0)
        if not valid:
            return {"units": "m", "validFrac": 0.0}
        n = len(valid)
        def pct(p):
            return valid[min(n - 1, int(p * n))]
        # centre patch (middle 20% x 20%) — the aim point of the head cam
        cx = [depth["values"][y * w + x]
              for y in range(int(h * 0.4), int(h * 0.6))
              for x in range(int(w * 0.4), int(w * 0.6))]
        cx = sorted(v for v in cx if v and v > 0)
        return {"units": "m", "validFrac": round(n / len(vals), 3),
                "min": valid[0], "p10": pct(0.10), "median": pct(0.50),
                "p90": pct(0.90),
                "centreMedian": cx[len(cx) // 2] if cx else None}

    async def do_look(self, req):
        agent = req.get("agentId", "agent")
        position = req.get("position")
        heading = req.get("headingDeg")
        mode = req.get("mode", "walk")
        async with self.lock:
            if not self.ready:
                return 503, {"ok": False, "error": "not-ready", "detail": self.last_error}
            pose, pose_ms, outcomes = await self.apply_pose(position, heading, mode)
            t0 = time.time()
            try:
                res = await asyncio.wait_for(
                    self.page.evaluate("window.__scout.look()"), timeout=600)
            except Exception as e:
                self.last_error = f"look: {type(e).__name__}: {e}"[:200]
                return 500, {"ok": False, "error": "look-failed", "detail": self.last_error}
            render_ms = round((time.time() - t0) * 1000)
            self.looks_served += 1
            img = res.get("image")
            png_b64 = img.split(",", 1)[1] if img and "," in img else None
            snap = res.get("snapshot") or {}
            if snap:
                pose = {"pos": snap["pos"], "headingDeg": snap["headingDeg"],
                        "bodyHeadingDeg": snap["bodyHeadingDeg"],
                        "groundY": snap["groundY"], "district": snap["district"],
                        "nearestPlace": snap["nearestPlace"]}
            return 200, {
                "ok": bool(png_b64), "agentId": agent,
                "png_b64": png_b64, "width": 512, "height": 288,
                "depthSummary": self.depth_summary(res.get("depth")),
                "camera": res.get("camera"),
                "pose": pose, "poseOutcomes": outcomes,
                "renderMs": render_ms, "poseMs": pose_ms,
                "pitch": 0, "pitchSupported": False,
                "simTime": res.get("simulationTime"),
                "utc": iso(),
            }

    async def do_snapshot(self, req):
        status, body = await self.do_look(req)
        if status != 200 or not body.get("png_b64"):
            return status, body
        data = base64.b64decode(body["png_b64"])
        agent = body["agentId"]
        self.snap_seq += 1
        ts = utcnow()
        fname = f"{agent}-{ts.strftime('%Y%m%dT%H%M%SZ')}-{self.snap_seq:03d}.png"
        fpath = SNAP_DIR / fname
        fpath.write_bytes(data)
        sha = hashlib.sha256(data).hexdigest()
        key = f"snapshots/{agent}/{fname}"
        rec = {"utc": iso(ts), "agentId": agent, "note": req.get("note", ""),
               "pose": body["pose"], "file": fname, "bytes": len(data),
               "sha256": sha, "r2Key": key, "renderMs": body["renderMs"]}
        if not R2_ENABLED:
            rec["r2Verified"] = False
            rec["r2Error"] = "disabled by LOOK_R2=0 (local persistence only)"
        else:
            try:
                http, _res = await asyncio.to_thread(r2_put, key, data, "image/png")
                n, sha2 = await asyncio.to_thread(r2_get_sha, key)
                rec["r2Http"] = http
                rec["r2Verified"] = (n == len(data) and sha2 == sha)
                rec["r2GetBytes"] = n
            except Exception as e:
                rec["r2Verified"] = False
                rec["r2Error"] = f"{type(e).__name__}: {e}"[:200]
        (SNAP_DIR / (fname + ".json")).write_text(json.dumps(rec, indent=1))
        with INDEX.open("a") as f:
            f.write(json.dumps(rec) + "\n")
        self.snapshots_kept += 1
        body["snapshot"] = rec
        return 200, body


SVC = LookService()


# ---------------------------------------------------------------- HTTP
async def handle(reader, writer):
    try:
        line = await reader.readline()
        if not line:
            writer.close(); return
        parts = line.decode("utf-8", "replace").split()
        method, path = parts[0], parts[1] if len(parts) > 1 else "/"
        length = 0
        headers = {}
        while True:
            h = await reader.readline()
            if h in (b"\r\n", b"\n", b""):
                break
            if b":" in h:
                k, v = h.split(b":", 1)
                headers[k.decode("utf-8", "replace").strip().lower()] = \
                    v.decode("utf-8", "replace").strip()
            if h.lower().startswith(b"content-length:"):
                length = int(h.split(b":", 1)[1].strip())
        raw = await reader.readexactly(length) if length else b""
        req = json.loads(raw) if raw else {}
        if method == "GET" and path == "/health":
            status, body = 200, {"ok": SVC.ready, "ready": SVC.ready,
                                 "coldStartMs": SVC.cold_start_ms,
                                 "warmSince": SVC.warm_since,
                                 "looksServed": SVC.looks_served,
                                 "snapshotsKept": SVC.snapshots_kept,
                                 "authRequired": AUTH_REQUIRED,
                                 "r2Enabled": R2_ENABLED,
                                 "pageUrl": PAGE_URL, "lastError": SVC.last_error}
        elif not authorized(headers):
            status, body = 401, {"ok": False, "error": "unauthorized"}
        elif method == "POST" and path == "/look":
            status, body = await SVC.do_look(req)
        elif method == "POST" and path == "/snapshot":
            status, body = await SVC.do_snapshot(req)
        elif method == "POST" and path == "/move":
            async with SVC.lock:
                if not SVC.ready:
                    status, body = 503, {"ok": False, "error": "not-ready"}
                else:
                    pose, pose_ms, outcomes = await SVC.apply_pose(
                        req.get("position"), req.get("headingDeg"), req.get("mode", "walk"))
                    status, body = 200, {"ok": True, "agentId": req.get("agentId", "agent"),
                                         "pose": pose, "poseMs": pose_ms, "outcomes": outcomes}
        else:
            status, body = 404, {"ok": False, "error": "no-route"}
    except Exception as e:
        status, body = 500, {"ok": False, "error": f"{type(e).__name__}: {e}"[:200]}
    payload = json.dumps(body).encode()
    reason = {200: "OK", 400: "Bad Request", 401: "Unauthorized", 404: "Not Found",
              500: "Internal Server Error", 503: "Service Unavailable"}.get(status, "Status")
    writer.write(f"HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\n"
                 f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n".encode()
                 + payload)
    await writer.drain()
    writer.close()


async def main():
    if not AUTH_REQUIRED:
        print("[service] WARNING: LOOK_SERVICE_SECRET unset or < 32 chars — "
              "DEV MODE, endpoints are UNAUTHENTICATED. Loopback bind only; "
              "never expose this instance beyond 127.0.0.1.", flush=True)
    if AUTH_REQUIRED and HTTP_HOST not in ("127.0.0.1", "localhost", "::1"):
        print(f"[service] auth ON, binding {HTTP_HOST} — the gateway is the "
              "only intended caller; keep the port firewalled to it.", flush=True)
    await SVC.start()
    server = await asyncio.start_server(handle, HTTP_HOST, HTTP_PORT)
    print(f"[service] HTTP on {HTTP_HOST}:{HTTP_PORT} authRequired={AUTH_REQUIRED}", flush=True)
    async with server:
        await server.serve_forever()


if __name__ == "__main__":
    asyncio.run(main())
