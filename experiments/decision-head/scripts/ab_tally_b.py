#!/usr/bin/env python3
"""Score ARM B (Jev re-fire) with the IDENTICAL metric code as ab_tally.py
(same ECE implementation), and produce the paired head-to-head vs Arm A
(original results/ab_luna.jsonl, untouched). Merges Jev fields into
results/ab_summary.json without disturbing Arm A's recorded numbers."""
import json, pathlib
import numpy as np
from sklearn.metrics import roc_auc_score, average_precision_score, balanced_accuracy_score, accuracy_score

ROOT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head"
luna = [json.loads(l) for l in open(ROOT / "results/ab_luna.jsonl")]
jev = [json.loads(l) for l in open(ROOT / "results/ab_jev.jsonl")]

def ece(ps, ys, bins=10):
    conf = np.maximum(ps, 1 - ps); pred = (ps >= 0.5).astype(int)
    out = 0.0
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        m = (conf > lo) & (conf <= hi) if b else (conf >= lo) & (conf <= hi)
        if m.sum(): out += (m.sum() / len(ys)) * abs(conf[m].mean() - (pred[m] == ys[m]).mean())
    return out

def score(rows, name):
    ok = [r for r in rows if r.get("p_egg") is not None]
    ys = np.array([1 if r["label"] == "egg" else 0 for r in ok])
    ps = np.array([r["p_egg"] for r in ok], dtype=float)
    lat = [r["latency_s"] for r in rows]
    m = {"n": len(ok), "acc": float(accuracy_score(ys, (ps >= 0.5).astype(int))),
         "bal_acc": float(balanced_accuracy_score(ys, (ps >= 0.5).astype(int))),
         "roc_auc": float(roc_auc_score(ys, ps)), "pr_auc": float(average_precision_score(ys, ps)),
         "ece": float(ece(ps, ys)), "eggs_found": int(((ps >= 0.5) & (ys == 1)).sum()),
         "eggs_total": int(ys.sum()), "egg_p": sorted([round(float(p), 3) for p in ps[ys == 1]], reverse=True),
         "lat_mean": float(np.mean(lat)), "lat_p50": float(np.median(lat)),
         "cost": float(sum(r.get("cost") or 0 for r in rows)),
         "cost_per_call": float(np.mean([r.get("cost") or 0 for r in rows])),
         "models": sorted(set(r.get("model") for r in ok if r.get("model")))}
    conf = np.maximum(ps, 1 - ps); pred = (ps >= 0.5).astype(int)
    for t in (0.7, 0.8, 0.9):
        mm = conf >= t
        m[f"abst_{t}"] = {"coverage": float(mm.mean()), "n": int(mm.sum()),
                          "acc": float((pred[mm] == ys[mm]).mean()) if mm.sum() else None}
    m["conf_wrong_hi"] = [(r["frame"].split('/')[-1], r["cand_idx"], round(float(r["p_egg"]), 3))
                          for r in ok if r["label"] != "egg" and r["p_egg"] >= 0.9]
    m["conf_wrong_lo"] = [(r["frame"].split('/')[-1], r["cand_idx"], round(float(r["p_egg"]), 3))
                          for r in ok if r["label"] == "egg" and r["p_egg"] <= 0.1]
    return m, ok, ys, ps

jm, jok, jys, jps = score(jev, "JEV")
lm, lok, lys, lps = score(luna, "LUNA")

print(f"JEV ARM (typesafe/jev-1.14 via Decisions API): {jm['n']}/{len(jev)} scored; models {jm['models']}")
print(f"  accuracy@0.5 {jm['acc']:.3f} | balanced {jm['bal_acc']:.3f} | ROC-AUC {jm['roc_auc']:.3f} | PR-AUC {jm['pr_auc']:.3f} | ECE {jm['ece']:.3f}")
print(f"  eggs found {jm['eggs_found']}/{jm['eggs_total']}; egg p values {jm['egg_p']}")
print(f"  confident-wrong (not-egg p>=0.9): {len(jm['conf_wrong_hi'])} {jm['conf_wrong_hi'][:6]}")
print(f"  confident-wrong (egg p<=0.1): {len(jm['conf_wrong_lo'])} {jm['conf_wrong_lo'][:6]}")
for t in (0.7, 0.8, 0.9):
    a = jm[f"abst_{t}"]; print(f"  abstain tau={t}: coverage {a['coverage']:.2f} (n={a['n']}), acc {a['acc']:.3f}" if a['acc'] is not None else f"  abstain tau={t}: n=0")
print(f"  latency: mean {jm['lat_mean']:.2f}s p50 {jm['lat_p50']:.2f}s | cost total ${jm['cost']:.4f} (${jm['cost_per_call']:.6f}/call)")

# paired head-to-head on identical items
jk = {(r["frame"], r["cand_idx"]): r for r in jok}
lk = {(r["frame"], r["cand_idx"]): r for r in lok}
both = set(jk) & set(lk)
jc = {k: (jk[k]["p_egg"] >= 0.5) == (jk[k]["label"] == "egg") for k in both}
lc = {k: (lk[k]["p_egg"] >= 0.5) == (lk[k]["label"] == "egg") for k in both}
jw = [k for k in both if jc[k] and not lc[k]]   # jev right, luna wrong
lw = [k for k in both if lc[k] and not jc[k]]   # luna right, jev wrong
print(f"PAIRED (n={len(both)} identical items): both-right {sum(1 for k in both if jc[k] and lc[k])}, "
      f"both-wrong {sum(1 for k in both if not jc[k] and not lc[k])}, jev-only-right {len(jw)}, luna-only-right {len(lw)}")

jud = [jk[k] for k in both if jk[k]["agnes_egg"] is not None]
if jud:
    ya = np.array([1 if r["label"] == "egg" else 0 for r in jud])
    ag = np.array([1 if r["agnes_egg"] else 0 for r in jud])
    jv = np.array([jk[(r["frame"], r["cand_idx"])]["p_egg"] for r in jud])
    lu = np.array([lk[(r["frame"], r["cand_idx"])]["p_egg"] for r in jud])
    print(f"JUDGED SUBSET (n={len(jud)}): Agnes {accuracy_score(ya, ag):.3f} | Luna {accuracy_score(ya, (lu>=0.5).astype(int)):.3f} | Jev {accuracy_score(ya, (jv>=0.5).astype(int)):.3f} | majority {max(ya.mean(),1-ya.mean()):.3f}")

s = json.load(open(ROOT / "results/ab_summary.json"))
s.update({"jev_ok": jm["n"], "jev_err": len(jev) - jm["n"], "jev_acc": jm["acc"],
          "jev_bal_acc": jm["bal_acc"], "jev_roc_auc": jm["roc_auc"], "jev_pr_auc": jm["pr_auc"],
          "jev_ece": jm["ece"], "jev_lat_mean": jm["lat_mean"], "jev_cost": jm["cost"],
          "jev_models": jm["models"]})
json.dump(s, open(ROOT / "results/ab_summary.json", "w"), indent=1)
json.dump({"jev": jm, "luna_check": {"n": lm["n"], "acc": lm["acc"]}}, open(ROOT / "results/ab_headtohead.json", "w"), indent=1, default=str)
print("wrote results/ab_summary.json (merged) + results/ab_headtohead.json")
