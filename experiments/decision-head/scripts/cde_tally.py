#!/usr/bin/env python3
"""Tally the Jev context experiment: five arms, one metric battery.
Metric code is ab_tally_b.py's score() VERBATIM (same ECE implementation),
applied to: A luna-digest (results/ab_luna.jsonl), B jev-digest
(results/ab_jev.jsonl), C jev-full-structured (results/cd_jev_full.jsonl),
D jev-full-nl (results/cd_jev_nl.jsonl), E luna-full-structured
(results/cd_luna_full.jsonl). Paired comparisons on identical items:
C vs B (quantity), D vs C (kind), E vs A (control), D vs B, C vs E, D vs E.
Writes results/cde_summary.json."""
import json, pathlib
import numpy as np
from sklearn.metrics import roc_auc_score, average_precision_score, balanced_accuracy_score, accuracy_score

ROOT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head"

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
    m = {"n": len(ok), "n_rows": len(rows), "acc": float(accuracy_score(ys, (ps >= 0.5).astype(int))),
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
    m["p_max_neg"] = float(ps[ys == 0].max()) if (ys == 0).any() else None
    m["p_spread"] = [float(ps.min()), float(ps.max())]
    return m, ok

ARMS = [("A_luna_digest", "results/ab_luna.jsonl", "Luna, digest (Arm A, this morning)"),
        ("B_jev_digest", "results/ab_jev.jsonl", "Jev, digest (Arm B, this morning)"),
        ("C_jev_full_struct", "results/cd_jev_full.jsonl", "Jev, FULL structured (Arm C)"),
        ("D_jev_full_nl", "results/cd_jev_nl.jsonl", "Jev, FULL natural language (Arm D)"),
        ("E_luna_full_struct", "results/cd_luna_full.jsonl", "Luna, FULL structured (Arm E)")]

res, okmap = {}, {}
for key, path, label in ARMS:
    rows = [json.loads(l) for l in open(ROOT / path)]
    m, ok = score(rows, key)
    res[key] = m; okmap[key] = {(r["frame"], r["cand_idx"]): r for r in ok}
    print(f"{label}: n={m['n']}/{m['n_rows']} | acc {m['acc']:.3f} | bal {m['bal_acc']:.3f} | "
          f"AUC {m['roc_auc']:.3f} | PR {m['pr_auc']:.3f} | ECE {m['ece']:.3f} | "
          f"eggs {m['eggs_found']}/{m['eggs_total']} p={m['egg_p']} | "
          f"cw>=0.9 {len(m['conf_wrong_hi'])} cw<=0.1 {len(m['conf_wrong_lo'])} | "
          f"p range {m['p_spread']} | lat {m['lat_mean']:.1f}s | ${m['cost']:.4f}")
    for t in (0.7, 0.8, 0.9):
        a = m[f"abst_{t}"]
        print(f"    abstain tau={t}: coverage {a['coverage']:.2f} (n={a['n']}), acc {a['acc']:.3f}" if a["acc"] is not None else f"    abstain tau={t}: n=0")

def paired(k1, k2, n1, n2):
    a, b = okmap[k1], okmap[k2]
    both = set(a) & set(b)
    ca = {k: (a[k]["p_egg"] >= 0.5) == (a[k]["label"] == "egg") for k in both}
    cb = {k: (b[k]["p_egg"] >= 0.5) == (b[k]["label"] == "egg") for k in both}
    only1 = sum(1 for k in both if ca[k] and not cb[k])
    only2 = sum(1 for k in both if cb[k] and not ca[k])
    print(f"PAIRED {n1} vs {n2} (n={len(both)}): both-right {sum(1 for k in both if ca[k] and cb[k])}, "
          f"both-wrong {sum(1 for k in both if not ca[k] and not cb[k])}, "
          f"{n1}-only-right {only1}, {n2}-only-right {only2}")
    return {"n": len(both), f"{k1}_only_right": only1, f"{k2}_only_right": only2}

pairs = {}
pairs["C_vs_B"] = paired("C_jev_full_struct", "B_jev_digest", "Jev-full", "Jev-digest")
pairs["D_vs_C"] = paired("D_jev_full_nl", "C_jev_full_struct", "Jev-NL", "Jev-struct")
pairs["E_vs_A"] = paired("E_luna_full_struct", "A_luna_digest", "Luna-full", "Luna-digest")
pairs["C_vs_E"] = paired("C_jev_full_struct", "E_luna_full_struct", "Jev-full", "Luna-full")
pairs["D_vs_E"] = paired("D_jev_full_nl", "E_luna_full_struct", "Jev-NL", "Luna-full")

# Agnes-judged subset (n=8) across all arms
sub = [k for k in okmap["A_luna_digest"] if okmap["A_luna_digest"][k]["agnes_egg"] is not None]
if sub:
    ya = np.array([1 if okmap["A_luna_digest"][k]["label"] == "egg" else 0 for k in sub])
    ag = np.array([1 if okmap["A_luna_digest"][k]["agnes_egg"] else 0 for k in sub])
    line = f"JUDGED SUBSET (n={len(sub)}): Agnes {accuracy_score(ya, ag):.3f}"
    for key, _, label in ARMS:
        p = np.array([okmap[key][k]["p_egg"] for k in sub if k in okmap[key]])
        yy = np.array([1 if okmap[key][k]["label"] == "egg" else 0 for k in sub if k in okmap[key]])
        line += f" | {label.split(',')[0]} {accuracy_score(yy, (p >= 0.5).astype(int)):.3f}"
    print(line)

items = [json.loads(l) for l in open(ROOT / "results/cde_items.jsonl")]
sizes = {}
for name, col in (("digest_B", "bytes_digest"), ("full_struct_C_E", "bytes_c"), ("full_nl_D", "bytes_d")):
    v = [i[col] for i in items]
    sizes[name] = {"mean_B": float(np.mean(v)), "max_B": int(max(v))}
print("STATE SIZES:", sizes)

total_new = res["C_jev_full_struct"]["cost"] + res["D_jev_full_nl"]["cost"] + res["E_luna_full_struct"]["cost"]
print(f"NEW SPEND (C+D+E): ${total_new:.4f}")
json.dump({"arms": res, "pairs": pairs, "state_sizes": sizes, "new_spend": total_new},
          open(ROOT / "results/cde_summary.json", "w"), indent=1, default=str)
print("wrote results/cde_summary.json")
