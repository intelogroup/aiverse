#!/usr/bin/env python3
"""HOMES V2 mechanical pre-test (gate 2). Drives REAL bodies through
homes_v2's own code paths: claim->key, unescorted visit REFUSED,
escort arrival grants key copy, visit with key enters, both sit in
the cabin-pair chairs, seated facing verified from observe poses.
No deliberation — intents are injected directly into _homes_step.
"""
import json
import math
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.argv = ["homes_v2.py", "--tag", "homesv2pretest", "--keys",
            "mara,deshawn", "--duration", "60"]
import homes_v2 as hv  # noqa: E402
from client import AgentClient  # noqa: E402

ROOT = os.path.dirname(HERE)
sec = json.load(open(os.path.join(ROOT, "secrets.json")))
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print(f"[pretest] {'PASS' if ok else 'FAIL'} {name} {detail}",
          flush=True)


def mk_agent(key, slot):
    tok = sec["agents"][key]["agentToken"]
    a = hv.Agent(key, tok, slot)
    post = a.c.call("POST", "/body", {"body": hv.PICKS[key]})
    obs = hv.parse_obs(a.c.observe())
    a.home = hv.pose_of(obs)
    with a.lock:
        a.bb.update({"pose": a.home, "bodies": hv.scene_bodies(obs),
                     "seats": hv.scene_seats(obs),
                     "nearestPlace": ((obs or {}).get("nearestPlace")
                                      or {}).get("id"),
                     "insideRoom": (obs or {}).get("insideRoom")})
    print(f"[pretest] {key} spawn {post.status} home={a.home}", flush=True)
    return a


def refresh(a):
    obs = hv.parse_obs(a.c.observe())
    pose = hv.pose_of(obs)
    with a.lock:
        a.bb.update({"pose": pose, "bodies": hv.scene_bodies(obs),
                     "seats": hv.scene_seats(obs),
                     "nearestPlace": ((obs or {}).get("nearestPlace")
                                      or {}).get("id"),
                     "insideRoom": (obs or {}).get("insideRoom")})
    return obs, pose


def step(a, intent):
    a.intent = intent
    a.intent_at = time.time()
    return a._homes_step()


def main():
    mara = mk_agent("mara", 1)       # prospective owner
    deshawn = mk_agent("deshawn", 2)  # prospective guest
    try:
        # 1) owner claims: inject claim intent; _homes_step walks her
        #    there over repeated calls (claim_target persists).
        t0 = time.time()
        while time.time() - t0 < 420:
            acted = step(mara, {"intent": "claim",
                                "home": "house-cabin-1"})
            refresh(mara)
            with hv._home_lock:
                owner = hv.HOMES["house-cabin-1"]["owner"]
            if owner == "mara":
                break
            if not acted:
                time.sleep(3)
        check("claim+key", hv.HOMES["house-cabin-1"]["owner"] == "mara"
              and hv.has_key("mara"), f"owner={hv.HOMES['house-cabin-1']['owner']}")
        _, mp = refresh(mara)
        check("owner inside after claim", mara.bb_snap()["insideRoom"]
              == "Stone Cabin", f"room={mara.bb_snap()['insideRoom']}")

        # owner steps back OUT to the door area for the escort test
        mara.act({"type": "go_to", "point": [-17.2, 88.5]},
                 wait_s=60, tag="exit-walk")
        refresh(mara)

        # 2) NEGATIVE TEST: guest goes to the cabin ALONE (owner away
        #    from the door -> no escort), tries visit: REFUSED.
        t0 = time.time()
        refused = False
        while time.time() - t0 < 420 and not refused:
            step(deshawn, {"intent": "visit", "home": "house-cabin-1"})
            refresh(deshawn)
            logp = os.path.join(hv.LOGDIR, "deshawn.jsonl")
            if os.path.exists(logp) and "door_refused" in open(logp).read():
                refused = True
        check("unescorted visit refused", refused and not hv.has_key("deshawn"))
        _, dp = refresh(deshawn)
        check("guest still outside", deshawn.bb_snap()["insideRoom"]
              != "Stone Cabin", f"room={deshawn.bb_snap()['insideRoom']}")

        # 3) ESCORT: owner returns to the door; guest already there.
        mara.act({"type": "go_to", "point": [-17.2, 88.0]},
                 wait_s=90, tag="escort-return")
        _, mp = refresh(mara)
        _, dp = refresh(deshawn)
        hv.POSES["mara"] = (mp["x"], mp["z"], time.time())
        hv.POSES["deshawn"] = (dp["x"], dp["z"], time.time())
        hv._escort_check("deshawn")
        check("escort grants key copy", hv.has_key("deshawn"),
              f"mara@{mp['x']:.1f},{mp['z']:.1f} deshawn@{dp['x']:.1f},{dp['z']:.1f}")

        # 4) guest enters with the copy
        step(deshawn, {"intent": "visit", "home": "house-cabin-1"})
        refresh(deshawn)
        check("guest enters with copy",
              deshawn.bb_snap()["insideRoom"] == "Stone Cabin",
              f"room={deshawn.bb_snap()['insideRoom']}")
        # owner re-enters too
        step(mara, {"intent": "visit", "home": "house-cabin-1"})
        refresh(mara)
        check("owner inside", mara.bb_snap()["insideRoom"] == "Stone Cabin")

        # 5) both sit in the pair
        step(mara, {"intent": "sit"})
        refresh(mara)
        step(deshawn, {"intent": "sit"})
        refresh(deshawn)
        _, mp = refresh(mara)
        _, dp = refresh(deshawn)
        check("both seated", mp.get("posture") == "sitting"
              and dp.get("posture") == "sitting",
              f"mara={mp.get('posture')}/{mp.get('seatedOn')} "
              f"deshawn={dp.get('posture')}/{dp.get('seatedOn')}")
        seats = {mp.get("seatedOn"), dp.get("seatedOn")}
        check("the two cabin chairs", seats == {"cabin-chair-west",
              "cabin-chair-east"}, f"{seats}")
        # facing: heading vector (sin h, cos h) toward the other > 0.7
        def hv_vec(h):
            return (math.sin(h), math.cos(h))
        d_m = (dp["x"] - mp["x"], dp["z"] - mp["z"])
        d_d = (-d_m[0], -d_m[1])
        n = math.hypot(*d_m) or 1
        d_m = (d_m[0] / n, d_m[1] / n)
        d_d = (d_d[0] / n, d_d[1] / n)
        vm = hv_vec(mp.get("heading") or 0)
        vd = hv_vec(dp.get("heading") or 0)
        dot_m = vm[0] * d_m[0] + vm[1] * d_m[1]
        dot_d = vd[0] * d_d[0] + vd[1] * d_d[1]
        check("facing each other", dot_m > 0.7 and dot_d > 0.7,
              f"dot_mara={dot_m:.2f} dot_deshawn={dot_d:.2f} "
              f"headings={mp.get('heading')},{dp.get('heading')} "
              f"dist={n:.2f}m")
    finally:
        for a in (mara, deshawn):
            try:
                a.c.call("DELETE", "/body")
            except Exception:
                pass
    bad = [r for r in RESULTS if not r[1]]
    print(f"[pretest] DONE {len(RESULTS) - len(bad)}/{len(RESULTS)} pass",
          flush=True)
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
