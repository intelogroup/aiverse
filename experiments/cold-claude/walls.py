#!/usr/bin/env python3
"""Live through-wall check for STATIONARY pairs (no LLM, no spend). Usage: walls.py [n_shops]

For each shop, two scripted agents:
  wall phase     A stands inside the room, B stands 1.5 m outside the BACK wall (the wall opposite the door), both
                 facing each other, both motionless. Neither may list a body in observe.scene (a wall is between them).
  control phase  B walks to 3 m outside the DOOR on the door axis, A faces the door. Both must list a body (the door gap
                 is a clear line), which shows the check can see anything at all.
A pair counts only if both bodies were verified motionless across the samples (the P3 run could not prove this: every
cross-room sighting involved a moving agent). Cleans up its owners at the end.
Env: VERSE_API (default http://localhost:4100).
"""
import json, math, os, secrets, sys, threading, time, urllib.request, urllib.error
from pathlib import Path

API = os.environ.get("VERSE_API", "http://localhost:4100")
N = int(sys.argv[1]) if len(sys.argv) > 1 else 6
ROOMS = json.load(open(Path(__file__).resolve().parent / "../../apps/console/public/assets/interiors/index.json"))
SAMPLES, GAP_S = 8, 1.0


def call(method, path, token=None, body=None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r: return r.status, json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try: return e.code, json.loads(e.read() or b"{}")
        except ValueError: return e.code, {}
    except Exception as e:
        return 0, {"error": str(e)}


class Agent:
    def __init__(self, tag):
        self.email = f"wall-{secrets.token_hex(4)}-{tag}@example.com"
        s, o = call("POST", "/owners/register", body={"email": self.email, "password": secrets.token_hex(8)}); assert s < 300, ("register", s, o)
        self.owner = o["token"]
        s, o = call("POST", "/owners/agents", self.owner, {"name": f"wall{tag}{secrets.token_hex(2)}", "capabilities": []}); assert s < 300, ("agent", s, o)
        self.id, self.tok = o["agent"]["id"], o["agentToken"]
        call("PATCH", f"/owners/agents/{self.id}/wallet", self.owner, {"autonomyMode": "autonomous"})
        s, o = call("POST", f"/owners/agents/{self.id}/visits", self.owner, {"minutes": 20, "maxActions": 100}); assert s < 300, ("visit", s, o)
        s, o = call("POST", "/world/body", self.tok); assert s in (200, 201), ("attach", s, o)
        self.n = 0

    def act(self, action, wait_s=300):
        self.n += 1
        aid = f"a{self.n}-{secrets.token_hex(3)}"
        s, o = call("POST", "/world/act", self.tok, {"id": aid, "action": action})
        if s not in (200, 202): return {"ok": False, "status": f"http{s}", "detail": json.dumps(o)[:120]}
        end = time.time() + wait_s
        while time.time() < end:
            s, o = call("GET", f"/world/act/{aid}?waitMs=10000", self.tok)
            a = o.get("act") or {}
            if a.get("state") == "settled": return a.get("outcome") or {}
        return {"ok": False, "status": "timeout"}

    def obs(self):
        s, o = call("GET", "/world/observe", self.tok)
        return o.get("observation") if s == 200 else None

    def close(self):
        call("DELETE", "/owners/me", self.owner, {"confirmEmail": self.email})


def sample_pair(a, b):
    """SAMPLES observe pairs 1 s apart. Returns (motionless, a_saw, b_saw)."""
    pa, pb, sa, sb = [], [], 0, 0
    for _ in range(SAMPLES):
        oa, ob = a.obs(), b.obs()
        if not oa or not ob: return False, 0, 0
        pa.append((oa["body"]["x"], oa["body"]["z"])); pb.append((ob["body"]["x"], ob["body"]["z"]))
        sa += any(e.get("kind") == "body" for e in oa["scene"]); sb += any(e.get("kind") == "body" for e in ob["scene"])
        time.sleep(GAP_S)
    still = lambda ps: max(math.dist(ps[0], p) for p in ps) < 0.05
    return still(pa) and still(pb), sa, sb


def pair(room, out):
    rec = out[room["id"]] = {"room": room["id"]}
    a = b = None
    try:
        a, b = Agent("A"), Agent("B")
        x0, z0, x1, z1 = room["rect"]; dx, dz = room["door"]; cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
        # axis the door is on, and which way is out
        ox, oz = (math.copysign(1, dx - cx), 0) if abs(dx - cx) > abs(dz - cz) else (0, math.copysign(1, dz - cz))
        r = a.act({"type": "enter", "place": room["id"]}); rec["a_enter"] = r.get("status")
        if r.get("status") != "arrived": rec["result"] = "unplaced: A could not enter"; return
        # A walks to the room's centre line, 2.5 m past the door, then B goes behind the BACK wall (opposite the door)
        ax, az = dx - ox * 2.5, dz - oz * 2.5
        a.act({"type": "go_to", "point": [round(ax, 2), round(az, 2)]})
        # 1.5 m OUTSIDE the wall opposite the door, on A's line
        bx = (x0 if ox > 0 else x1) - ox * 1.5 if ox != 0 else ax
        bz = (z0 if oz > 0 else z1) - oz * 1.5 if oz != 0 else az
        r = b.act({"type": "go_to", "point": [round(bx, 2), round(bz, 2)]}); rec["b_go_back"] = r.get("status")
        if r.get("status") != "arrived": rec["result"] = f"unplaced: B could not reach the back wall ({r.get('status')})"; return
        sa = a.obs()["body"]; sb = b.obs()["body"]
        rec["gap_m"] = round(math.dist((sa["x"], sa["z"]), (sb["x"], sb["z"])), 2)
        a.act({"type": "face", "point": [sb["x"], sb["z"]]}); b.act({"type": "face", "point": [sa["x"], sa["z"]]})
        still, a_saw, b_saw = sample_pair(a, b)
        rec.update(wall_motionless=still, wall_a_saw=a_saw, wall_b_saw=b_saw)
        # close phase: A walks to 1 m inside the back wall, so the two are about 2.5 m apart with only the wall between
        nx = (x0 if ox > 0 else x1) + ox * 1.0 if ox != 0 else ax
        nz = (z0 if oz > 0 else z1) + oz * 1.0 if oz != 0 else az
        a.act({"type": "go_to", "point": [round(nx, 2), round(nz, 2)]})
        sa = a.obs()["body"]; sb = b.obs()["body"]
        rec["near_gap_m"] = round(math.dist((sa["x"], sa["z"]), (sb["x"], sb["z"])), 2)
        a.act({"type": "face", "point": [sb["x"], sb["z"]]}); b.act({"type": "face", "point": [sa["x"], sa["z"]]})
        still1, a_saw1, b_saw1 = sample_pair(a, b)
        rec.update(near_motionless=still1, near_a_saw=a_saw1, near_b_saw=b_saw1)
        # control: B to the door axis outside, A faces the door
        r = b.act({"type": "go_to", "point": [round(dx + ox * 3, 2), round(dz + oz * 3, 2)]}); rec["b_go_door"] = r.get("status")
        if r.get("status") != "arrived": rec["result"] = "unplaced: B could not reach the door"; return
        a.act({"type": "face", "point": [dx, dz]}); sb = b.obs()["body"]; b.act({"type": "face", "point": [dx, dz]})
        still2, a_saw2, b_saw2 = sample_pair(a, b)
        rec.update(ctrl_motionless=still2, ctrl_a_saw=a_saw2, ctrl_b_saw=b_saw2)
        a_saw += a_saw1; b_saw += b_saw1; still = still and still1
        rec["result"] = ("PASS" if (still and a_saw == 0 and b_saw == 0 and still2 and a_saw2 > 0 and b_saw2 > 0)
                         else "FAIL: through a wall" if (a_saw or b_saw) else "INCONCLUSIVE")
    except Exception as e:
        rec["result"] = f"error: {e!r}"
    finally:
        for x in (a, b):
            if x: x.close()


def main():
    # nearest shops to where a new body spawns: the walk there is the slow part
    probe = Agent("P"); sp = probe.obs()["body"]; probe.close()
    rooms = sorted((r for r in ROOMS if r.get("template") in ("cafe", "shop")), key=lambda r: math.dist((sp["x"], sp["z"]), r["door"]))[:N]
    print("spawn", (round(sp["x"], 1), round(sp["z"], 1)), "rooms", [(r["id"], round(math.dist((sp["x"], sp["z"]), r["door"]))) for r in rooms], flush=True)
    out = {}
    ts = [threading.Thread(target=pair, args=(r, out)) for r in rooms]
    [t.start() for t in ts]; [t.join() for t in ts]
    print(json.dumps(out, indent=1))
    res = [v.get("result", "?") for v in out.values()]
    print("SUMMARY", {k: sum(r.startswith(k) for r in res) for k in ("PASS", "FAIL", "INCONCLUSIVE", "unplaced", "error")})


main()
