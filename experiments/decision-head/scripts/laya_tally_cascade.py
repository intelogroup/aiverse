#!/usr/bin/env python3
"""Tally arms F/G/H (Laya zero-shot) + I (fine-tuned head) on the 120 with
the IDENTICAL metric code as ab_tally_b.py (score()/ece() copied verbatim),
fit triage thresholds OUT of the test batch, and simulate the Luna cascades
offline from stored probabilities (no new API calls).

Threshold fitting discipline:
  - zero-shot Laya (never saw any split): fitted on TRAIN-split scores.
  - arm I head (trained on train): fitted on VAL-split scores (train would
    be in-sample for it); a train-fitted number is also reported, labeled.
  - Jev-NL: no train-split scores exist and no new API calls are allowed,
    so its only threshold is the in-sample one from cde_thresholds.json --
    used in the cascade table and labeled IN-SAMPLE wherever it appears.
Cascade confirm stage: Arm E (Luna full-structured) per-item p, egg iff
p >= 0.5 -- Luna-alone is the 120-call reference."""
import json, pathlib
import numpy as np
from sklearn.metrics import roc_auc_score, average_precision_score, balanced_accuracy_score, accuracy_score

ROOT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head"
RES = ROOT / "results"

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
    lat = [r["latency_s"] for r in rows if r.get("latency_s") is not None]
    m = {"n": len(ok), "acc": float(accuracy_score(ys, (ps >= 0.5).astype(int))),
         "bal_acc": float(balanced_accuracy_score(ys, (ps >= 0.5).astype(int))),
         "roc_auc": float(roc_auc_score(ys, ps)), "pr_auc": float(average_precision_score(ys, ps)),
         "ece": float(ece(ps, ys)), "eggs_found": int(((ps >= 0.5) & (ys == 1)).sum()),
         "eggs_total": int(ys.sum()), "egg_p": sorted([round(float(p), 3) for p in ps[ys == 1]], reverse=True),
         "lat_mean": float(np.mean(lat)) if lat else None, "lat_p50": float(np.median(lat)) if lat else None,
         "cost": 0.0, "cost_per_call": 0.0, "models": ["convaiinnovations/laya@55cf4c4"]}
    conf = np.maximum(ps, 1 - ps); pred = (ps >= 0.5).astype(int)
    for t in (0.7, 0.8, 0.9):
        mm = conf >= t
        m[f"abst_{t}"] = {"coverage": float(mm.mean()), "n": int(mm.sum()),
                          "acc": float((pred[mm] == ys[mm]).mean()) if mm.sum() else None}
    m["conf_wrong_hi"] = [(r["frame"].split('/')[-1], r["cand_idx"], round(float(r["p_egg"]), 3))
                          for r in ok if r["label"] != "egg" and r["p_egg"] >= 0.9]
    m["conf_wrong_lo"] = [(r["frame"].split('/')[-1], r["cand_idx"], round(float(r["p_egg"]), 3))
                          for r in ok if r["label"] == "egg" and r["p_egg"] <= 0.1]
    m["p_spread"] = [float(ps.min()), float(ps.max())]
    return m

def load(fn):
    return [json.loads(l) for l in open(RES / fn)]

cde120 = load("cde_items.jsonl")
keys120 = {(r["frame"], r["cand_idx"]) for r in cde120}
labels120 = {(r["frame"], r["cand_idx"]): r["label"] for r in cde120}

arms = {}
for arm, fn in [("F_laya_digest", "laya_f_digest.jsonl"),
                ("G_laya_full_struct", "laya_g_struct.jsonl"),
                ("H_laya_full_nl", "laya_h_nl.jsonl")]:
    rows = [r for r in load(fn) if (r["frame"], r["cand_idx"]) in keys120]
    assert len(rows) == 120, (arm, len(rows))
    arms[arm] = (score(rows, arm), {(r["frame"], r["cand_idx"]): r["p_egg"] for r in rows})

# arm I: fine-tuned head probs, 120-subset of its test rows; calibrated p primary
head = load("head_fmt_probs.jsonl")
for variant, pf in [("I_head_cal", "p_egg_cal"), ("I_head_raw", "p_egg_raw")]:
    rows = [{"frame": r["frame"], "cand_idx": r["cand_idx"], "label": r["label"],
             "p_egg": r[pf], "latency_s": None}
            for r in head if (r["frame"], r["cand_idx"]) in keys120]
    assert len(rows) == 120, (variant, len(rows))
    mm = score(rows, variant)
    mm["models"] = ["ModernBERT-base head (v2 protocol), field=" + head[0]["field"]]
    arms[variant] = (mm, {(r["frame"], r["cand_idx"]): r["p_egg"] for r in rows})

for a, (m, _) in arms.items():
    print(f"{a}: acc {m['acc']:.3f} bal {m['bal_acc']:.3f} AUC {m['roc_auc']:.3f} "
          f"PR {m['pr_auc']:.3f} ECE {m['ece']:.3f} eggs {m['eggs_found']}/4 {m['egg_p']} "
          f"lat {m['lat_mean'] if m['lat_mean'] is None else round(m['lat_mean'],3)}s")

# ---------------- threshold fitting ---------------------------------------
def youden_t(scores, labels):
    ss = sorted(set(scores), reverse=True)
    best, bt = -2, None
    ys = np.array(labels); ps = np.array(scores)
    for t in ss:
        pred = ps >= t
        tpr = ((pred == 1) & (ys == 1)).sum() / max((ys == 1).sum(), 1)
        fpr = ((pred == 1) & (ys == 0)).sum() / max((ys == 0).sum(), 1)
        if tpr - fpr > best: best, bt = tpr - fpr, t
    return bt

def all_eggs_t(scores, labels):
    egg_scores = [s for s, l in zip(scores, labels) if l == 1]
    return min(egg_scores) if egg_scores else None

def fit_report(scores, labels, where):
    yt = youden_t(scores, labels); at = all_eggs_t(scores, labels)
    def ev(t):
        if t is None: return None
        passed = [i for i, s in enumerate(scores) if s >= t]
        return {"t": round(float(t), 4), "passed": len(passed),
                "eggs_passed": int(sum(labels[i] for i in passed)),
                "fp_passed": int(sum(1 - labels[i] for i in passed))}
    return {"fitted_on": where, "n": len(scores), "n_egg": int(sum(labels)),
            "youden": ev(yt), "all_eggs": ev(at)}

# Laya zero-shot train-split scores per format (for fitting)
train_scores = {}
for field, fn in [("context", "laya_train_digest.jsonl"),
                  ("state_c", "laya_train_struct.jsonl"),
                  ("state_d", "laya_train_nl.jsonl")]:
    p = RES / fn
    if p.exists():
        rr = load(fn)
        train_scores[field] = ([r["p_egg"] for r in rr],
                               [1 if r["label"] == "egg" else 0 for r in rr])
field_of = {"F_laya_digest": "context", "G_laya_full_struct": "state_c", "H_laya_full_nl": "state_d"}
fits = {}
for arm in ("F_laya_digest", "G_laya_full_struct", "H_laya_full_nl"):
    f = field_of[arm]
    if f in train_scores:
        s, l = train_scores[f]
        fits[arm] = fit_report(s, l, "train split (427, zero-shot: never trained on)")
# arm I fits: val (honest) + train (in-sample for the head, labeled)
hv = [r for r in head if r["split"] == "val"]; ht = [r for r in head if r["split"] == "train"]
fits["I_head_cal_on_val"] = fit_report([r["p_egg_cal"] for r in hv],
                                       [1 if r["label"] == "egg" else 0 for r in hv],
                                       "val split (117; head did not train on val)")
fits["I_head_cal_on_train_INSAMPLE"] = fit_report([r["p_egg_cal"] for r in ht],
                                       [1 if r["label"] == "egg" else 0 for r in ht],
                                       "train split (IN-SAMPLE for the head -- optimistic, reference only)")
# Jev-NL threshold: in-sample from cde_thresholds.json (no train scores exist)
ct = json.load(open(RES / "cde_thresholds.json"))["D_jev_full_nl"]
fits["D_jev_full_nl_INSAMPLE"] = {"fitted_on": "the 120 test items themselves (IN-SAMPLE; no Jev train scores exist, no new API calls allowed)",
                                  "youden": {"t": ct["youden_threshold_in_sample"], "eggs_passed": ct["youden_eggs"], "fp_passed": ct["youden_fp"]},
                                  "all_eggs": {"t": ct["all_eggs_threshold"], "eggs_passed": 4, "fp_passed": ct["fp_at_all_eggs"]}}

# ---------------- cascade simulation --------------------------------------
lunaE = {(r["frame"], r["cand_idx"]): r["p_egg"] for r in load("cd_luna_full.jsonl")}
jevD = {(r["frame"], r["cand_idx"]): r["p_egg"] for r in load("cd_jev_nl.jsonl")}
ys120 = {k: (1 if v == "egg" else 0) for k, v in labels120.items()}

def luna_alone():
    conf_e = sum(1 for k in keys120 if ys120[k] == 1 and lunaE[k] >= 0.5)
    conf_f = sum(1 for k in keys120 if ys120[k] == 0 and lunaE[k] >= 0.5)
    return {"luna_calls": 120, "eggs_confirmed": conf_e, "fp_confirmed": conf_f}
LA = luna_alone()

def cascade(scores, t=None, topk=None):
    if topk is not None:
        short = {k for k, _ in sorted(scores.items(), key=lambda kv: -kv[1])[:topk]}
    else:
        short = {k for k, s in scores.items() if s >= t}
    return {"t": t, "topk": topk, "luna_calls": len(short),
            "eggs_passed": int(sum(ys120[k] for k in short)),
            "eggs_confirmed": int(sum(1 for k in short if ys120[k] == 1 and lunaE[k] >= 0.5)),
            "fp_confirmed": int(sum(1 for k in short if ys120[k] == 0 and lunaE[k] >= 0.5))}

def sweep(scores):
    """Cheapest shortlist (by threshold) preserving Luna-alone confirmed eggs;
    and cheapest passing all 4 eggs to Luna."""
    ts = sorted(set(scores.values()), reverse=True)
    keep = passall = None
    for t in ts:
        c = cascade(scores, t=t)
        if keep is None and c["eggs_confirmed"] >= LA["eggs_confirmed"] and c["eggs_passed"] >= LA["eggs_confirmed"]:
            keep = c
        if passall is None and c["eggs_passed"] == 4:
            passall = c
    return {"cheapest_preserving_luna_confirmed": keep, "cheapest_passing_all_4_eggs": passall}

def _spread(a):
    rows = [r for r in load({"F_laya_digest": "laya_f_digest.jsonl",
                             "G_laya_full_struct": "laya_g_struct.jsonl",
                             "H_laya_full_nl": "laya_h_nl.jsonl"}[a])]
    return len({r["p_egg"] for r in rows})
best_zs = max((a for a in ("F_laya_digest", "G_laya_full_struct", "H_laya_full_nl")
               if _spread(a) > 1),
              key=lambda a: arms[a][0]["roc_auc"])
print("best non-degenerate zero-shot Laya arm by AUC:", best_zs,
      "(arms with a single unique p are constant-output and excluded)")
casc = {"luna_alone_reference": LA, "judges": {}}
judge_scores = {"D_jev_full_nl": jevD, best_zs: arms[best_zs][1],
                "I_head_cal": arms["I_head_cal"][1]}
judge_fits = {"D_jev_full_nl": fits["D_jev_full_nl_INSAMPLE"],
              best_zs: fits.get(best_zs), "I_head_cal": fits["I_head_cal_on_val"]}
for name, sc in judge_scores.items():
    entry = {"sweep": sweep(sc), "at_fitted_youden": None, "at_fitted_all_eggs": None,
             "topk": {k: cascade(sc, topk=k) for k in (10, 20, 30, 40)}}
    fr = judge_fits[name]
    if fr is None:
        entry["fit_provenance"] = ("NO out-of-sample fit available for this judge "
                                   "(train-split scores absent) -- sweep/top-k only")
    else:
        if fr.get("youden"): entry["at_fitted_youden"] = cascade(sc, t=fr["youden"]["t"])
        if fr.get("all_eggs"): entry["at_fitted_all_eggs"] = cascade(sc, t=fr["all_eggs"]["t"])
        entry["fit_provenance"] = fr["fitted_on"]
    casc["judges"][name] = entry
    print(name, json.dumps(entry, default=str)[:400])

json.dump({"arms": {a: m for a, (m, _) in arms.items()}, "best_zero_shot": best_zs,
           "fits": fits}, open(RES / "laya_summary.json", "w"), indent=1, default=str)
json.dump(casc, open(RES / "cascade_summary.json", "w"), indent=1, default=str)
print("wrote results/laya_summary.json + results/cascade_summary.json")
