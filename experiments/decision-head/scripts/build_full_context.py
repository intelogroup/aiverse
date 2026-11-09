#!/usr/bin/env python3
"""Build FULL-context states for the Jev context experiment (Arms C/D/E).

Same 120 held-out items as the A/B (results/ab_items.jsonl, untouched).
For each item, reconstruct the fullest decision-moment context the recorded
logs actually carry, and render it two ways from ONE fact dict:
  state_c -- structured: the original digest verbatim + appended fact blocks
  state_d -- natural language: the same facts as a prose situation
Arm E reuses state_c verbatim (Luna control).

Fact sources (all on disk, nothing invented):
  digest/ranks/geometry ... decision-head/results/ab_items.jsonl (= dataset_a row)
  candidate field ......... egg-hunt/cv_results_rgb.json (full per-frame cand list)
  frame scan verdict ...... cv row's `vlm` field (frame-level, constant per frame)
  candidate surface range . egg-hunt/{frame}-depth.png, decoded with the app's
                            own encoding g = 255*(1 - d/45) (percept_uncertainty.py)
  calibration curves ...... visibility/percept_uncertainty.py constants:
                            sigma_vlm(r)=0.32r, p_detect(r), sigma_depth(r),
                            claim-worthy iff sigma_2d <= 0.75 m (~2.3 m approach)
NOT in the logs for these staged items (stated in the report, never faked):
  agent world pose/heading, look-budget state, episodic/blackboard entries,
  candidate world position, camera FOV in degrees (bearing kept in pixels).
  Agnes's own verdicts exist for 8 of the items and are EXCLUDED by design
  (another judge's answer is not context).
"""
import json, math, pathlib
import numpy as np
from PIL import Image

ROOT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head"
EH = pathlib.Path.home() / "workspace/.build-tmp/experiments/egg-hunt"
W, H = 512, 288

items = [json.loads(l) for l in open(ROOT / "results/ab_items.jsonl")]
cv = json.load(open(EH / "cv_results_rgb.json"))
cv_rows = {r["frame"]: r for r in cv["rows"]}

# --- percept_uncertainty.py curves, recomputed inline (same constants) -----
def sigma_vlm(r): return 0.32 * r
def p_detect(r):
    if r <= 8.0: return 1.0
    if r <= 15.0: return 1.0 - (r - 8.0) * (0.67 / 7.0)
    return 0.15
def sigma_depth(r): return (45.0 / 255.0 / math.sqrt(12)) * (1.0 + (r / 12.0) ** 4)
def depth_blind(r): return sigma_depth(r) > 1.0

_depth_cache = {}
def depth_patch_stats(frame, bbox):
    if frame not in _depth_cache:
        dep = np.asarray(Image.open(EH / (frame.replace(".png", "-depth.png")))).astype(float)
        _depth_cache[frame] = dep[..., 0] if dep.ndim == 3 else dep
    dep = _depth_cache[frame]
    x0, y0, x1, y1 = bbox
    patch = dep[y0:y1 + 1, x0:x1 + 1].ravel()
    counts = np.bincount(patch.astype(int), minlength=256)
    smooth = np.array([counts[max(0, g - 2):g + 3].sum() for g in range(256)])
    g_mode = int(np.argmax(smooth))
    d = 45.0 * (1.0 - patch / 255.0)
    return {"g_mode": g_mode, "d_mode": 45.0 * (1.0 - g_mode / 255.0),
            "coherence": float(smooth[g_mode] / len(patch)),
            "d_p10": float(np.percentile(d, 10)), "d_p90": float(np.percentile(d, 90))}

def sector(dx, dy):
    sh = "near the horizontal centre" if abs(dx) <= 42 else ("left of centre" if dx < 0 else "right of centre")
    sv = "near the vertical centre" if abs(dy) <= 24 else ("above centre" if dy < 0 else "below centre")
    return sh, sv

SCAN_C = {
    "hit": "a full-frame VLM scan of this view reported an egg sighting in it.",
    "hit_phantom": "a full-frame VLM scan of this view reported an egg sighting in it, plus a second report the module flagged as a likely phantom.",
}
SCAN_D = {
    "hit": "did report seeing an egg somewhere in it",
    "hit_phantom": "did report seeing an egg somewhere in it, along with a second report the module itself flagged as a likely phantom",
}
def scan_kind(vlm):
    return "hit_phantom" if "phantom" in vlm else "hit"

out = []
for r in items:
    f = r["frame"]
    crow = cv_rows[f]
    cands = crow["cands"]
    me = cands[r["cand_idx"]]
    assert tuple(me["bbox"]) == tuple(r["bbox"]), (f, r["cand_idx"])
    others = [c for j, c in enumerate(cands) if j != r["cand_idx"]]
    top = max(others, key=lambda c: c["ovoid"]) if others else None
    n_above = sum(1 for c in others if c["ovoid"] > r["ovoid"])
    ds = depth_patch_stats(f, r["bbox"])
    dist = r["dist_m"]
    dx, dy = r["cx"] - W / 2, r["cy"] - H / 2
    sh, sv = sector(dx, dy)
    sk = scan_kind(crow["vlm"])
    facts = {"frame": f, "cand_idx": r["cand_idx"], "label": r["label"],
             "agnes_egg": r["agnes_egg"], "dist_m": dist,
             "depth_g_mode": ds["g_mode"], "depth_d_mode": round(ds["d_mode"], 2),
             "depth_coherence": round(ds["coherence"], 3),
             "depth_p10": round(ds["d_p10"], 2), "depth_p90": round(ds["d_p90"], 2),
             "sigma_depth": round(sigma_depth(ds["d_mode"]), 3) if 1 < ds["g_mode"] < 254 else None,
             "depth_blind": bool(depth_blind(ds["d_mode"])),
             "sigma_vlm": round(sigma_vlm(dist), 2), "p_detect": round(p_detect(dist), 2),
             "dx": round(dx), "dy": round(dy),
             "n_above_ovoid": n_above,
             "top_other_ovoid": round(top["ovoid"], 2) if top else None,
             "top_other_area": top["area"] if top else None,
             "scan": sk, "vlm_raw": crow["vlm"]}

    # ---------------- Arm C: structured -----------------------------------
    if ds["g_mode"] <= 1:
        depth_c = ("depth channel (recorded with the frame; 8-bit, 45 m full scale): "
                   "the dominant return inside this candidate's box is the far limit "
                   "(45 m) -- sky or no return; no usable surface range.")
    elif ds["g_mode"] >= 254:
        depth_c = ("depth channel (recorded with the frame; 8-bit, 45 m full scale): "
                   "the dominant return inside this candidate's box is the near limit "
                   "(0 m) -- sensor artefact; no usable surface range.")
    else:
        depth_c = (f"depth channel (recorded with the frame; 8-bit, 45 m full scale): "
                   f"the dominant surface inside this candidate's box reads {ds['d_mode']:.1f} m "
                   f"({ds['coherence']:.0%} of the box's pixels agree within one depth step); "
                   f"the box's depth spread (10th-90th percentile) is {ds['d_p10']:.1f}-{ds['d_p90']:.1f} m. "
                   f"depth-read sigma at {ds['d_mode']:.1f} m is {sigma_depth(ds['d_mode']):.2f} m"
                   + ("; at this range the depth channel cannot resolve an egg-sized (0.85 m) "
                      "object -- treat the read as weak." if facts["depth_blind"] else "."))
    state_c = r["context"] + "\n" + "\n".join([
        "--- additional recorded context for this look ---",
        depth_c,
        (f"position in frame: centre is {dx:+.0f} px horizontally, {dy:+.0f} px vertically "
         f"from the centre of the {W}x{H} frame ({sh}, {sv})."),
        (f"perception calibration (fitted on staged trials of this rig): a VLM position report "
         f"from {dist:.0f} m carries sigma_2d = {sigma_vlm(dist):.1f} m; detection probability "
         f"for a real egg at {dist:.0f} m is {p_detect(dist):.2f}; a position is claim-worthy "
         f"only at sigma_2d <= 0.75 m, i.e. from about 2.3 m."),
        (f"candidate field: {n_above} of the other {len(cands) - 1} candidates score a higher "
         f"ovoid than this one; the strongest other candidate has ovoid {top['ovoid']:.2f}, "
         f"area {top['area']} px, box {top['bbox'][2] - top['bbox'][0]}x{top['bbox'][3] - top['bbox'][1]} px."),
        f"frame scan: {SCAN_C[sk]}",
    ])

    # ---------------- Arm D: natural language ------------------------------
    if ds["g_mode"] <= 1:
        depth_d = ("Its depth sensor, recorded with the same frame, returns sky or no "
                   "signal for most of this patch, so there is no usable surface range for it.")
    elif ds["g_mode"] >= 254:
        depth_d = ("Its depth sensor, recorded with the same frame, returns a near-limit "
                   "artefact for most of this patch, so there is no usable surface range for it.")
    else:
        depth_d = (f"Its depth sensor, recorded with the same frame, reads the surface filling "
                   f"most of this patch as one plane about {ds['d_mode']:.1f} metres away "
                   f"(about {ds['coherence']:.0%} of the patch agrees on that range; the rest "
                   f"spreads between {ds['d_p10']:.1f} and {ds['d_p90']:.1f} metres), with a depth "
                   f"uncertainty of roughly {sigma_depth(ds['d_mode']):.2f} metres"
                   + ("; beyond about 15 metres this depth channel can no longer resolve an "
                      "egg-sized object, so that reading is weak." if facts["depth_blind"] else "."))
    pdet_d = {1.0: "essentially every time", 0.33: "about a third of the time"}.get(
        round(p_detect(dist), 2), f"about {p_detect(dist):.0%} of the time")
    ar_word = "taller than it is wide" if r["ar"] < 1 else ("wider than it is tall" if r["ar"] > 1 else "as wide as it is tall")
    dx_d = f"{abs(dx):.0f} pixels {'left of' if dx < 0 else 'right of' if dx > 0 else 'at'} the centre" if dx else "at the horizontal centre"
    dy_d = f"{abs(dy):.0f} pixels {'above' if dy < 0 else 'below' if dy > 0 else 'at'} the centre" if dy else "at the vertical centre"
    state_d = (
        f"You are deciding for an agent that hunts collectible eggs in a 3D market world. "
        f"The agent took one camera look (a {W}-by-{H} view) while examining a spot "
        f"{dist:.0f} metres away, and a full-frame scan of this same view {SCAN_D[sk]}. "
        f"Its vision software outlined {r['n_cand']} candidate objects in the view. "
        f"The candidate in question is number {r['cand_idx'] + 1} of the {r['n_cand']}: a patch "
        f"{r['w']} pixels wide and {r['h']} pixels tall (area {r['area']} square pixels, its box "
        f"starting at pixel {r['bbox'][0]}, {r['bbox'][1]}), centred {dx_d} horizontally and "
        f"{dy_d} vertically. The patch is {ar_word} (aspect ratio {r['ar']:.2f}) and fills "
        f"{r['extent']:.0%} of its bounding box; the software's egg-shape score for it is "
        f"{r['ovoid']:.2f}, ranking it {r['rank_ovoid']} of {r['n_cand']} by egg-shape and "
        f"{r['rank_area']} by size, with {n_above} other candidates scoring a higher egg-shape "
        f"score -- the strongest of those scores {top['ovoid']:.2f} and covers {top['area']} "
        f"square pixels. {depth_d} "
        f"From experience with this perception system, a position it reports from {dist:.0f} "
        f"metres away is typically uncertain by about {sigma_vlm(dist):.1f} metres, it notices "
        f"a real egg at that distance {pdet_d}, and the agent may only grab at an object when "
        f"the position uncertainty is below 0.75 metres, which in practice means approaching "
        f"to about 2.3 metres first.")

    out.append({"frame": f, "cand_idx": r["cand_idx"], "label": r["label"],
                "agnes_egg": r["agnes_egg"], "context": r["context"],
                "state_c": state_c, "state_d": state_d, "facts": facts,
                "bytes_digest": len(r["context"].encode()),
                "bytes_c": len(state_c.encode()), "bytes_d": len(state_d.encode())})

with open(ROOT / "results/cde_items.jsonl", "w") as fh:
    for o in out: fh.write(json.dumps(o) + "\n")

import collections
print(f"wrote {len(out)} items -> results/cde_items.jsonl")
for k in ("bytes_digest", "bytes_c", "bytes_d"):
    v = [o[k] for o in out]
    print(f"  {k}: mean {sum(v)/len(v):.0f} B, max {max(v)} B (threshold ~32768 B)")
print("depth g_mode distribution:", collections.Counter(
    "far-limit" if o["facts"]["depth_g_mode"] <= 1 else
    "near-limit" if o["facts"]["depth_g_mode"] >= 254 else "surface" for o in out))
print("scan kinds:", collections.Counter(o["facts"]["scan"] for o in out))
eggs = [o for o in out if o["label"] == "egg"]
for o in eggs:
    f = o["facts"]
    print(f"  EGG {o['frame'].split('/')[-1]} d_mode={f['depth_d_mode']} coh={f['depth_coherence']} "
          f"p10-p90={f['depth_p10']}-{f['depth_p90']} sigma_vlm={f['sigma_vlm']} staged={f['dist_m']}")
