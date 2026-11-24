#!/usr/bin/env python3
"""Open-Day analysis: from a run tag dir (logs/tracks) + store DB + feed.
Outputs analysis-data.json in the open-day folder:
  activity mix over time (2-min buckets, act types + postures),
  energy stats per agent (min, exhausted blocks, rest ticks),
  rest clustering (ticks with >=2 seated agents within 12 m of each other),
  XP table by source per agent, final bags.
Usage: analyze_openday.py <tag_dir> <store.db> [feed.jsonl]
"""
import glob
import json
import math
import os
import sys
from collections import Counter, defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from store import Store  # noqa: E402


def main():
    tag_dir, db = sys.argv[1], sys.argv[2]
    feed_path = sys.argv[3] if len(sys.argv) > 3 else None
    keys = sorted(os.path.basename(p)[:-6]
                  for p in glob.glob(os.path.join(tag_dir, "logs", "*.jsonl")))
    mix = defaultdict(Counter)       # bucket -> act type counts
    posture = defaultdict(Counter)   # bucket -> posture counts
    energy_min = {}
    exhausted = Counter()
    deliberations = Counter()
    says = Counter()
    heard = Counter()
    t0 = None
    seated_ticks = defaultdict(list)  # tick idx -> [(key, x, z)]
    for key in keys:
        emin = 100.0
        for line in open(os.path.join(tag_dir, "logs", f"{key}.jsonl")):
            try:
                ev = json.loads(line)
            except Exception:
                continue
            t = ev.get("t")
            if t is None:
                continue
            t0 = t if t0 is None else min(t0, t)
            b = int((t - t0) // 120)
            k = ev.get("kind")
            if k == "act":
                mix[b][(ev.get("action") or {}).get("type", "?")] += 1
            elif k == "observe":
                p = (ev.get("pose") or {}).get("posture")
                if p:
                    posture[b][p] += 1
                if isinstance(ev.get("energy"), (int, float)):
                    emin = min(emin, ev["energy"])
            elif k == "exhausted_block":
                exhausted[key] += 1
            elif k == "deliberation":
                deliberations[key] += 1
            elif k == "say_sent":
                says[key] += 1
            elif k == "heard":
                heard[key] += 1
        energy_min[key] = emin
        # seated positions from tracks
        tp = os.path.join(tag_dir, "tracks", f"{key}.jsonl")
        if os.path.exists(tp):
            for line in open(tp):
                try:
                    ev = json.loads(line)
                except Exception:
                    continue
                selfp = ev.get("self") or {}
                if selfp.get("posture") in ("sitting", "seated") \
                        and isinstance(selfp.get("x"), (int, float)):
                    tick = int((ev["t"] - t0) // 8)
                    seated_ticks[tick].append(
                        (key, selfp["x"], selfp["z"],
                         round(selfp["x"], 1), round(selfp["z"], 1)))
    # rest clustering: per tick, pairs of distinct seated agents <= 12 m
    cluster_ticks = 0
    pair_counts = Counter()
    spot_counts = Counter()
    for tick, lst in seated_ticks.items():
        clustered = False
        for i in range(len(lst)):
            spot_counts[(lst[i][3], lst[i][4])] += 1
            for j in range(i + 1, len(lst)):
                if lst[i][0] != lst[j][0] and math.hypot(
                        lst[i][1] - lst[j][1],
                        lst[i][2] - lst[j][2]) <= 12:
                    clustered = True
                    pair_counts[tuple(sorted((lst[i][0], lst[j][0])))] += 1
        if clustered:
            cluster_ticks += 1
    s = Store(db)
    xp_table = {k: {"total": s.xp_of(k), "by_source": s.xp_by_source(k),
                    "energy_min": energy_min.get(k),
                    "exhausted_blocks": exhausted.get(k, 0),
                    "says": says.get(k, 0), "heard": heard.get(k, 0),
                    "deliberations": deliberations.get(k, 0),
                    "bag": [e["item"] for e in s.bag_of(k)],
                    "visited": s.visited(k)}
                for k in keys}
    feed_events = Counter()
    if feed_path and os.path.exists(feed_path):
        for line in open(feed_path):
            try:
                feed_events[json.loads(line).get("kind")] += 1
            except Exception:
                pass
    out = {"keys": keys,
           "activity_mix_by_2min": {str(b): dict(c)
                                    for b, c in sorted(mix.items())},
           "posture_by_2min": {str(b): dict(c)
                               for b, c in sorted(posture.items())},
           "rest_clustering": {
               "ticks_with_seated_cluster": cluster_ticks,
               "total_seated_ticks": len(seated_ticks),
               "top_pairs": pair_counts.most_common(8),
               "top_rest_spots": [(f"{x},{z}", n) for (x, z), n
                                  in spot_counts.most_common(8)]},
           "xp_table": xp_table,
           "feed_events": dict(feed_events)}
    dest = os.path.join(os.path.dirname(os.path.abspath(db)),
                        "analysis-data.json")
    with open(dest, "w") as f:
        json.dump(out, f, indent=1)
    print("wrote", dest)
    print(json.dumps({"xp_table": {k: v["total"] for k, v in
                                   xp_table.items()},
                      "rest_clustering": out["rest_clustering"]},
                     indent=1))


if __name__ == "__main__":
    main()
