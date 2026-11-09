#!/usr/bin/env python3
"""Tally the A/B batch: Luna metrics on completed items; Jev blocker census;
Agnes head-to-head on the judged subset. n stated beside every number."""
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

ok = [r for r in luna if r["p_egg"] is not None]
ys = np.array([1 if r["label"] == "egg" else 0 for r in ok])
ps = np.array([r["p_egg"] for r in ok])
lat = [r["latency_s"] for r in luna]
print(f"LUNA ARM (openai/gpt-6-luna via OpenRouter chat): {len(ok)}/{len(luna)} items scored")
print(f"  batch composition: {int(ys.sum())} egg / {len(ys)-int(ys.sum())} not-egg "
      f"(enriched held-out sample: all 4 test eggs + judged + top-ovoid hard negatives + random)")
print(f"  accuracy@0.5 {accuracy_score(ys, (ps>=0.5).astype(int)):.3f} | balanced acc "
      f"{balanced_accuracy_score(ys, (ps>=0.5).astype(int)):.3f} | majority baseline "
      f"{max(ys.mean(), 1-ys.mean()):.3f}")
print(f"  ROC-AUC {roc_auc_score(ys, ps):.3f} | PR-AUC {average_precision_score(ys, ps):.3f} | ECE {ece(ps, ys):.3f}")
print(f"  eggs scored >=0.5: {int(((ps>=0.5)&(ys==1)).sum())}/{int(ys.sum())}; egg p values: "
      f"{sorted([round(float(p),3) for p in ps[ys==1]], reverse=True)}")
conf = np.maximum(ps, 1 - ps); pred = (ps >= 0.5).astype(int)
for t in (0.6, 0.7, 0.8, 0.9):
    m = conf >= t
    print(f"  abstain tau={t}: coverage {m.mean():.2f} (n={int(m.sum())}), acc on answered "
          f"{(pred[m]==ys[m]).mean() if m.sum() else float('nan'):.3f}")
print(f"  latency per call: mean {np.mean(lat):.1f}s p50 {np.median(lat):.1f}s (6-way concurrent, via egress proxy)")
print(f"  cost: total ${sum(r.get('cost') or 0 for r in luna):.4f} "
      f"(mean ${np.mean([r.get('cost') or 0 for r in luna]):.6f}/call)")
cw = [(r["frame"].split('/')[-1], r["cand_idx"], round(float(r['p_egg']), 3)) for r in ok
      if r["label"] != "egg" and r["p_egg"] >= 0.9]
print(f"  confident-wrong (not-egg with p>=0.9): {len(cw)} {cw[:6]}")

jud = [r for r in ok if r["agnes_egg"] is not None]
if jud:
    ya = np.array([1 if r["label"] == "egg" else 0 for r in jud])
    ag = np.array([1 if r["agnes_egg"] else 0 for r in jud])
    lu = np.array([r["p_egg"] for r in jud])
    print(f"JUDGED SUBSET (n={len(jud)}, same items): Agnes acc {accuracy_score(ya, ag):.3f} | "
          f"Luna acc {accuracy_score(ya, (lu>=0.5).astype(int)):.3f} | majority {max(ya.mean(),1-ya.mean()):.3f}")

jok = [r for r in jev if r["status"] == 200]
jerr = [r for r in jev if r["status"] != 200]
print(f"JEV ARM (typesafe/jev-1.14 via OpenRouter Decisions API): {len(jok)}/{len(jev)} succeeded; "
      f"{len(jerr)} errors, statuses {sorted(set(r['status'] for r in jerr))}")
if jerr: print(f"  blocker (verbatim, first): {jerr[0].get('error','')[:400]}")
print(f"  jev spend ${sum(r.get('cost') or 0 for r in jev):.4f}")
json.dump({"luna_n": len(ok), "luna_acc": float(accuracy_score(ys, (ps>=0.5).astype(int))),
           "luna_bal_acc": float(balanced_accuracy_score(ys, (ps>=0.5).astype(int))),
           "luna_roc_auc": float(roc_auc_score(ys, ps)), "luna_pr_auc": float(average_precision_score(ys, ps)),
           "luna_ece": float(ece(ps, ys)), "luna_lat_mean": float(np.mean(lat)),
           "luna_cost": float(sum(r.get('cost') or 0 for r in luna)),
           "jev_ok": len(jok), "jev_err": len(jerr), "jev_cost": 0.0},
          open(ROOT / "results/ab_summary.json", "w"), indent=1)
print("wrote results/ab_summary.json")
