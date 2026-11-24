#!/usr/bin/env python3
"""Analyze one phase dir (logs/ tracks/ summary.json [bounty.json]).
Usage: analyze.py <phase_dir> -> writes <phase_dir>/analysis.json, prints it."""
import json
import math
import os
import statistics
import sys
from bisect import bisect_left

KEYS = ["mara", "deshawn", "ingrid", "tomas", "priya", "kenji", "fatima",
        "oleg", "lucia", "amara", "henrik", "yuki", "rafael", "ngozi", "sam"]
NAMES = {k: k.capitalize() for k in KEYS}
NAMES["tomas"] = "Tomas"


def load_jsonl(path):
    out = []
    if os.path.exists(path):
        for line in open(path):
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


def main():
    d = sys.argv[1]
    summary = json.load(open(os.path.join(d, "summary.json")))
    tracks, logs = {}, {}
    for k in KEYS:
        tracks[k] = [e for e in load_jsonl(os.path.join(d, "tracks", k + ".jsonl"))
                     if e.get("kind") == "pose" and e.get("self")]
        logs[k] = load_jsonl(os.path.join(d, "logs", k + ".jsonl"))

    # per-agent distance from self poses (cap each step at 10 m)
    dist = {}
    series = {}
    for k in KEYS:
        pts = [(e["t"], e["self"]["x"], e["self"]["z"]) for e in tracks[k]
               if isinstance(e["self"].get("x"), (int, float))]
        series[k] = pts
        tot = 0.0
        for (t0, x0, z0), (t1, x1, z1) in zip(pts, pts[1:]):
            step = math.hypot(x1 - x0, z1 - z0)
            if step <= 10:
                tot += step
        dist[k] = round(tot, 1)

    # encounter pairs: co-location <= 6 m, sampled on each agent's ticks
    def nearest(pts, ts, t):
        i = bisect_left(ts, t)
        best = None
        for j in (i - 1, i):
            if 0 <= j < len(pts):
                dt = abs(pts[j][0] - t)
                if best is None or dt < best[0]:
                    best = (dt, pts[j])
        return best[1] if best and best[0] <= 6 else None

    pair_s = {}
    for a in KEYS:
        ts_a = [p[0] for p in series[a]]
        for b in KEYS:
            if b <= a or not series[a] or not series[b]:
                continue
            ts_b = [p[0] for p in series[b]]
            acc = 0.0
            prev_t = None
            for (t, x, z) in series[a]:
                q = nearest(series[b], ts_b, t)
                if q and math.hypot(x - q[1], z - q[2]) <= 6.0:
                    if prev_t is not None:
                        acc += min(t - prev_t, 10)
                    prev_t = t
                else:
                    prev_t = None
            if acc > 0:
                pair_s[f"{a}|{b}"] = round(acc)
    top_pairs = sorted(pair_s.items(), key=lambda kv: -kv[1])[:5]

    # name use: says (from logs) containing another cohort member's name
    name_use = {}
    for k in KEYS:
        n = 0
        for e in logs[k]:
            if e.get("kind") == "say_sent":
                txt = (e.get("text") or "").lower()
                if any(NAMES[o].lower() in txt for o in KEYS if o != k):
                    n += 1
        name_use[k] = n

    act_ms, obs_ms = [], []
    stalls = heard_ev = 0
    for k in KEYS:
        for e in logs[k]:
            if e.get("kind") == "act":
                act_ms.append(e.get("wall_ms", 0))
            elif e.get("kind") == "observe":
                obs_ms.append(e.get("obs_ms", 0))
            elif e.get("kind") == "stall_watchdog":
                stalls += 1
            elif e.get("kind") == "heard":
                heard_ev += 1

    totals = {f: sum(summary[k][f] for k in summary)
              for f in ("acts", "says", "heard", "deliberations", "greets")}
    out = {
        "phase_dir": d,
        "totals": totals,
        "per_agent": {k: {"acts": summary[k]["acts"], "says": summary[k]["says"],
                          "heard": summary[k]["heard"],
                          "deliberations": summary[k]["deliberations"],
                          "greets": summary[k]["greets"],
                          "distance_m": dist[k],
                          "visit_dead": summary[k]["visit_dead"],
                          "name_use_says": name_use[k],
                          "shard": summary[k].get("shard")}
                      for k in summary},
        "top_pairs_seconds": [{"pair": p, "seconds": s} for p, s in top_pairs],
        "session1_pairs_seconds": {p: pair_s.get(p, 0) for p in ("deshawn|mara", "amara|lucia", "deshawn|kenji")},
        "act_wall_ms_median": round(statistics.median(act_ms)) if act_ms else None,
        "act_wall_ms_p90": round(sorted(act_ms)[int(len(act_ms) * 0.9)]) if act_ms else None,
        "observe_ms_median": round(statistics.median(obs_ms)) if obs_ms else None,
        "stall_watchdog_fires": stalls,
        "visit_dead_count": sum(1 for k in summary if summary[k]["visit_dead"]),
    }
    bj = os.path.join(d, "bounty.json")
    if os.path.exists(bj):
        b = json.load(open(bj))
        seen = {}
        for k in KEYS:
            for e in logs[k]:
                if e.get("kind") == "bounty_seen":
                    seen[k] = e.get("offset_ms")
        out["bounty"] = {
            "winner": b["winner"], "code": b["code"],
            "n_claims": len(b["claims"]),
            "claims": b["claims"],
            "claims_by_shard": {},
            "seen_offset_ms": seen,
            "seen_skew_ms": (max(seen.values()) - min(seen.values())) if len(seen) > 1 else None,
        }
        for c in b["claims"]:
            s = str(c.get("shard"))
            out["bounty"]["claims_by_shard"][s] = out["bounty"]["claims_by_shard"].get(s, 0) + 1
    with open(os.path.join(d, "analysis.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
