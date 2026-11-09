#!/usr/bin/env python3
"""Build the type-(a) candidate confirm/reject dataset from egg-hunt artifacts.

Sources (all under ~/workspace/.build-tmp/experiments/egg-hunt/):
  cv_results_rgb.json  - every CV-proposer candidate in 14 staged frames,
                         with geometry features (bbox, area, ar, extent, ovoid, cx, cy)
                         and the frame's staged distance.
  fovea_results.json   - the 26 candidates Agnes judged in the foveated-confirm
                         test, with ground truth is_egg_cand + Agnes's verdict.

Label join: in each of the 11 egg-bearing frames exactly one candidate is the
true egg -- the one the fovea pipeline judged with is_egg_cand=True (verified:
its bbox appears in the frame's full candidate list, 11/11). All other
candidates are not-egg. In the 3 remaining frames no candidate is the egg
(the egg was not surfaced by the proposer -- a proposer-recall miss, which
does not corrupt candidate labels).

Split discipline: BY FRAME (candidates from one frame never cross splits).
"""
import json, random, collections, pathlib

EH = pathlib.Path.home() / "workspace/.build-tmp/experiments/egg-hunt"
OUT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head/data"

cv = json.load(open(EH / "cv_results_rgb.json"))
fr = json.load(open(EH / "fovea_results.json"))

judged = {}   # frame -> {bbox_tuple: crop}
for r in fr["results"]:
    judged[r["frame"]] = {tuple(c["cand_bbox"]): c for c in r["crops"]}

rows = []
frame_info = {}
for row in cv["rows"]:
    f, dist = row["frame"], row["dist"]
    cands = row["cands"]
    # proposer ranks within frame (the CV pre-filter's own ordering signals)
    by_ovoid = sorted(range(len(cands)), key=lambda i: -cands[i]["ovoid"])
    by_area = sorted(range(len(cands)), key=lambda i: -cands[i]["area"])
    rank_ovoid = {idx: r + 1 for r, idx in enumerate(by_ovoid)}
    rank_area = {idx: r + 1 for r, idx in enumerate(by_area)}
    jmap = judged.get(f, {})
    frame_info[f] = {"dist": dist, "n_cand": len(cands), "egg_found_cv": row["egg_found"]}
    for i, c in enumerate(cands):
        b = tuple(c["bbox"])
        crop = jmap.get(b)
        is_egg = bool(crop and crop["is_egg_cand"])
        w = c["bbox"][2] - c["bbox"][0]
        h = c["bbox"][3] - c["bbox"][1]
        rows.append({
            "frame": f, "dist_m": dist, "cand_idx": i,
            "bbox": c["bbox"], "w": w, "h": h, "area": c["area"],
            "ar": c["ar"], "extent": c["extent"], "ovoid": c["ovoid"],
            "cx": c["cx"], "cy": c["cy"],
            "rank_ovoid": rank_ovoid[i], "rank_area": rank_area[i],
            "n_cand": len(cands),
            "label": "egg" if is_egg else "not_egg",
            "agnes_egg": (crop["agnes_egg"] if crop else None),
            "agnes_conf": (crop.get("conf") if crop else None),
            "agnes_latency_s": (crop.get("latency_s") if crop else None),
        })

frames = sorted(frame_info)
print(f"candidates={len(rows)} positives={sum(r['label']=='egg' for r in rows)} frames={len(frames)}")
for f in frames:
    n = sum(1 for r in rows if r["frame"] == f)
    p = sum(1 for r in rows if r["frame"] == f and r["label"] == "egg")
    print(f"  {f}  dist={frame_info[f]['dist']}  cands={n}  egg={p}")

# ---- viewpoint-group-disjoint split (fixed, stated) ------------------------
# Frames sharing a viewpoint id (e.g. A-011 rendered by both the agnes and
# luna batches) are near-duplicate scenes; they are grouped and never split
# across train/val/test. Groups: A-001 x4 frames, A-011 x2, 8 singletons.
import re
def viewpoint(f):
    m = re.search(r"(A-\d+)\.png$", f)
    return m.group(1) if m else f
groups = {}
for f in frames: groups.setdefault(viewpoint(f), []).append(f)
test_vps = ["A-011", "A-051", "A-061", "A-091"]   # 3 egg viewpoints + one 15 m no-egg
val_vps = ["A-031", "A-081"]                      # 1 egg (4 m) + one 15 m no-egg
test_frames = [f for vp in test_vps for f in groups[vp]]
val_frames = [f for vp in val_vps for f in groups[vp]]
train_frames = [f for f in frames if f not in test_frames and f not in val_frames]
split_of = {}
for f in train_frames: split_of[f] = "train"
for f in val_frames: split_of[f] = "val"
for f in test_frames: split_of[f] = "test"
for r in rows: r["split"] = split_of[r["frame"]]
print("\nsplit frames:", {s: [f for f in frames if split_of[f] == s] for s in ("train", "val", "test")})
for s in ("train", "val", "test"):
    sub = [r for r in rows if r["split"] == s]
    print(f"{s}: {len(sub)} cands, {sum(r['label']=='egg' for r in sub)} egg, "
          f"{sum(r['agnes_egg'] is not None for r in sub)} agnes-judged")

def context_text(r):
    return (f"staged look, target distance {r['dist_m']:.0f} m. "
            f"candidate {r['cand_idx']+1} of {r['n_cand']} from the CV proposer. "
            f"bbox x {r['bbox'][0]} y {r['bbox'][1]} w {r['w']} h {r['h']}. "
            f"area {r['area']} px. aspect {r['ar']:.2f}. extent {r['extent']:.2f}. "
            f"ovoid score {r['ovoid']:.2f}. centre ({r['cx']:.0f}, {r['cy']:.0f}). "
            f"proposer rank by ovoid {r['rank_ovoid']}, by area {r['rank_area']}.")

for r in rows: r["context"] = context_text(r)

with open(OUT / "dataset_a.jsonl", "w") as fh:
    for r in rows: fh.write(json.dumps(r) + "\n")
print("\nwrote", OUT / "dataset_a.jsonl")
