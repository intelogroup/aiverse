#!/usr/bin/env python3
"""Smoke check for the photo path (POST /world/see), end to end through the gateway. Run it after every look-service deploy.

Takes three photos with a real agent body (where it stands, turned 120 degrees, and after a 3 m walk) and checks each:
  done        the job finished with a photo (a `failed` job is retried once: a cold page can time out)
  not blank   the PNG decodes and its pixels vary
  first person  nothing fills the near field: depthSummary.p10 >= 0.5 m (the agent's own head in frame read 0.31 m)
  pose        the camera stood where the body stands: poseErrorM <= 0.75 and poseMismatch false
              (reported as "n/a" when the service is too old to send them)
Exit 0 when every photo passes, 1 otherwise. Needs an agent with an active visit and a body.

Env:  VERSE_API (default http://127.0.0.1:3010), AIVERSE_AGENT_TOKEN (never pass the token on the command line),
      SMOKE_OUT (optional directory to keep the PNGs).
"""
import base64, json, os, struct, sys, time, urllib.error, urllib.request, zlib

API = os.environ.get("VERSE_API", "http://127.0.0.1:3010").rstrip("/")
TOKEN = os.environ.get("AIVERSE_AGENT_TOKEN", "")
OUT = os.environ.get("SMOKE_OUT")
P10_MIN_M, POSE_MAX_M = 0.5, 0.75


def call(method, path, body=None, timeout=30):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json", "authorization": f"Bearer {TOKEN}"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def act(action):
    aid = f"smoke-{int(time.time() * 1000)}"
    s, j = call("POST", "/world/act", {"id": aid, "action": action})
    if s != 202:
        return f"refused {s} {json.dumps(j)[:120]}"
    while True:
        s, j = call("GET", f"/world/act/{aid}?waitMs=10000")
        if s == 429:
            time.sleep(1.2); continue
        if s != 200 or (j.get("act") or {}).get("state") == "settled":
            return ((j.get("act") or {}).get("outcome") or {}).get("status", s)


def see():
    for _ in range(40):
        s, j = call("POST", "/world/see", {})
        if s == 202:
            break
        if s != 429:
            return {"state": "refused", "error": f"{s} {json.dumps(j)[:120]}"}
        time.sleep(3)
    sid = j["see"]["id"]
    while True:
        s, j = call("GET", f"/world/see/{sid}?waitMs=10000")
        st = (j.get("see") or {}).get("state")
        if s == 200 and st in ("done", "failed"):
            return j["see"]
        if s not in (200, 429):
            return {"state": "failed", "error": f"poll {s}"}


def png_stddev(png):
    """Standard deviation of the decoded bytes of an 8-bit RGB/RGBA PNG (stdlib only). 0 means a flat image."""
    assert png[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    pos, idat, w = 8, b"", 0
    while pos < len(png):
        n, kind = struct.unpack(">I4s", png[pos:pos + 8])
        data = png[pos + 8:pos + 8 + n]
        if kind == b"IHDR":
            w, h, depth, ctype = struct.unpack(">IIBB", data[:10])
            bpp = {2: 3, 6: 4}[ctype]
        elif kind == b"IDAT":
            idat += data
        pos += 12 + n
    raw, stride = zlib.decompress(idat), w * bpp
    prev, vals = bytearray(stride), []
    for y in range(len(raw) // (stride + 1)):
        f, line = raw[y * (stride + 1)], bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        for i in range(stride):
            a = line[i - bpp] if i >= bpp else 0
            b, c = prev[i], (prev[i - bpp] if i >= bpp else 0)
            if f == 1: line[i] = (line[i] + a) & 255
            elif f == 2: line[i] = (line[i] + b) & 255
            elif f == 3: line[i] = (line[i] + ((a + b) >> 1)) & 255
            elif f == 4:
                p = a + b - c; pa, pb, pc = abs(p - a), abs(p - b), abs(p - c)
                line[i] = (line[i] + (a if pa <= pb and pa <= pc else b if pb <= pc else c)) & 255
        vals.extend(line[::7]); prev = line
    m = sum(vals) / len(vals)
    return (sum((v - m) ** 2 for v in vals) / len(vals)) ** 0.5


def check(name):
    t0 = time.time()
    r = see()
    retried = False
    if r.get("state") != "done":
        retried = True
        r = see()
    row = {"shot": name, "state": r.get("state"), "retried": retried, "seconds": round(time.time() - t0)}
    fails = []
    if r.get("state") != "done":
        fails.append(f"no photo ({r.get('error')})")
    else:
        png = base64.b64decode(r["photoPng"])
        if OUT:
            os.makedirs(OUT, exist_ok=True); open(os.path.join(OUT, f"{name}.png"), "wb").write(png)
        row["stddev"] = round(png_stddev(png), 1)
        if row["stddev"] < 4: fails.append("blank image")
        p10 = (r.get("depthSummary") or {}).get("p10")
        row["p10M"] = p10
        if p10 is not None and p10 < P10_MIN_M: fails.append(f"something fills the near field (p10 {p10} m): own body in frame?")
        err, mism = r.get("poseErrorM"), r.get("poseMismatch")
        row["poseErrorM"] = "n/a" if err is None else err
        if err is not None and (err > POSE_MAX_M or mism): fails.append(f"camera {err} m from the body")
        row["renderMs"] = r.get("renderMs")
    row["result"] = "PASS" if not fails else "FAIL: " + "; ".join(fails)
    print(json.dumps(row), flush=True)
    return not fails


def main():
    if not TOKEN:
        print("set AIVERSE_AGENT_TOKEN"); return 2
    s, j = call("GET", "/world/observe")
    if s != 200:
        print(f"observe answered {s}: the agent needs an active visit and a body"); return 2
    b = j["observation"]["body"]
    ok = [check("1_where_it_stands")]
    print("face:", act({"type": "face", "headingDeg": 120}))
    ok.append(check("2_turned"))
    print("walk:", act({"type": "go_to", "point": [b["x"] + 3, b["z"]]}))
    ok.append(check("3_after_walk"))
    print(f"SMOKE {'PASS' if all(ok) else 'FAIL'} ({sum(ok)}/3)")
    return 0 if all(ok) else 1


if __name__ == "__main__":
    sys.exit(main())
