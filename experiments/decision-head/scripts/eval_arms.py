#!/usr/bin/env python3
"""Bake-off evaluation for decision type (a). Arms:
  majority | ovoid heuristic | logistic regression | fine-tuned head (raw+cal)
  | Laya zero-shot (if probs present) | Agnes (logged verdicts, judged subset)
Metrics: ROC-AUC, PR-AUC, balanced accuracy, ECE + reliability bins,
abstention (accuracy vs coverage), per-frame egg ranking, latency.
"""
import json, pathlib, time
import numpy as np
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, average_precision_score, balanced_accuracy_score, accuracy_score

ROOT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head"
rows = [json.loads(l) for l in open(ROOT / "data/dataset_a.jsonl")]
FEATS = ["dist_m", "w", "h", "area", "ar", "extent", "ovoid", "cx", "cy", "rank_ovoid", "rank_area", "n_cand"]
y = {s: np.array([1 if r["label"] == "egg" else 0 for r in rows if r["split"] == s]) for s in ("train", "val", "test")}
by = {s: [r for r in rows if r["split"] == s] for s in ("train", "val", "test")}

def X(sub): return np.array([[r[f] for f in FEATS] for r in sub], dtype=float)
sc = StandardScaler().fit(X(by["train"]))
lr = LogisticRegression(class_weight="balanced", max_iter=2000, C=1.0)
lr.fit(sc.transform(X(by["train"])), y["train"])
lr_p = {s: lr.predict_proba(sc.transform(X(by[s])))[:, 1] for s in by}

def temp_fit(ps, ys):
    def nll(T):
        z = np.log(np.clip(ps, 1e-9, 1)) / T; z -= z.max()
        p = np.exp(z); p /= p.sum()
        return -np.log(max(p, 1e-12)) if False else None
    # binary temperature on p_egg
    def nll_b(T):
        lo = np.log(np.clip(ps, 1e-9, 1 - 1e-9)); lo1 = np.log(np.clip(1 - ps, 1e-9, 1))
        z1, z0 = lo / T, lo1 / T
        m = np.maximum(z1, z0); p1 = np.exp(z1 - m) / (np.exp(z1 - m) + np.exp(z0 - m))
        return -np.mean(ys * np.log(np.clip(p1, 1e-12, 1)) + (1 - ys) * np.log(np.clip(1 - p1, 1e-12, 1)))
    Ts = np.linspace(0.3, 5.0, 95)
    return float(Ts[int(np.argmin([nll_b(t) for t in Ts]))])
def temp_apply(ps, T):
    lo = np.log(np.clip(ps, 1e-9, 1 - 1e-9)); lo1 = np.log(np.clip(1 - ps, 1e-9, 1))
    z1, z0 = lo / T, lo1 / T
    m = np.maximum(z1, z0)
    return np.exp(z1 - m) / (np.exp(z1 - m) + np.exp(z0 - m))
T_lr = temp_fit(lr_p["val"], y["val"])
lr_pc = {s: temp_apply(lr_p[s], T_lr) for s in lr_p}

head = {}
hp = ROOT / "results/head_probs.jsonl"
if hp.exists():
    for l in open(hp):
        d = json.loads(l); head[(d["frame"], d["cand_idx"])] = d
head_p = {s: np.array([head[(r["frame"], r["cand_idx"])]["p_egg_raw"] for r in by[s]]) for s in by}
head_pc = {s: np.array([head[(r["frame"], r["cand_idx"])]["p_egg_cal"] for r in by[s]]) for s in by}

laya_p = None
lp = ROOT / "results/laya_probs.jsonl"
if lp.exists():
    lm = {}
    for l in open(lp):
        d = json.loads(l); lm[(d["frame"], d["cand_idx"])] = d["p_egg"]
    if all((r["frame"], r["cand_idx"]) in lm for r in by["test"]):
        laya_p = {s: np.array([lm[(r["frame"], r["cand_idx"])] for r in by[s]]) for s in by}

prev = y["train"].mean()
arms = {
    "majority": {s: np.full(len(by[s]), prev) for s in by},
    "ovoid_heuristic": {s: np.array([r["ovoid"] for r in by[s]]) for s in by},
    "logreg_raw": lr_p, "logreg_cal": lr_pc,
}
if head_p: arms["head_raw"] = head_p; arms["head_cal"] = head_pc
if laya_p: arms["laya_zeroshot"] = laya_p

def ece(ps, ys, bins=10):
    conf = np.maximum(ps, 1 - ps); pred = (ps >= 0.5).astype(int)
    out, tot = 0.0, len(ys)
    for b in range(bins):
        lo, hi = b / bins, (b + 1) / bins
        m = (conf > lo) & (conf <= hi) if b else (conf >= lo) & (conf <= hi)
        if m.sum(): out += (m.sum() / tot) * abs(conf[m].mean() - (pred[m] == ys[m]).mean())
    return out

def abstain(ps, ys):
    conf = np.maximum(ps, 1 - ps); pred = (ps >= 0.5).astype(int)
    res = {}
    for t in (0.5, 0.6, 0.7, 0.8, 0.9):
        m = conf >= t
        res[t] = {"coverage": float(m.mean()), "acc": float((pred[m] == ys[m]).mean()) if m.sum() else None}
    return res

print(f"LR temperature (val): {T_lr:.2f}")
print(f"\n=== TEST candidate-level (n={len(by['test'])}, egg={int(y['test'].sum())}) ===")
print(f"{'arm':<18} {'ROC-AUC':>8} {'PR-AUC':>7} {'balAcc':>7} {'acc@.5':>7} {'ECE':>6}")
summary = {}
for name, P in arms.items():
    ps = P["test"]; ys = y["test"]
    roc = roc_auc_score(ys, ps) if ys.sum() else float("nan")
    pr = average_precision_score(ys, ps) if ys.sum() else float("nan")
    ba = balanced_accuracy_score(ys, (ps >= 0.5).astype(int))
    ac = accuracy_score(ys, (ps >= 0.5).astype(int))
    e = ece(ps, ys)
    summary[name] = {"roc_auc": roc, "pr_auc": pr, "bal_acc": ba, "acc": ac, "ece": e,
                     "abstain": abstain(ps, ys)}
    print(f"{name:<18} {roc:>8.3f} {pr:>7.3f} {ba:>7.3f} {ac:>7.3f} {e:>6.3f}")

print("\n=== Per-frame egg ranking (val+test frames with an egg) ===")
vt = by["val"] + by["test"]; yt = np.concatenate([y["val"], y["test"]])
frames = sorted(set(r["frame"] for r in vt if r["label"] == "egg"))
for name, P in arms.items():
    ps = np.concatenate([P["val"], P["test"]]) if name in arms else None
    ranks = []
    for f in frames:
        idx = [i for i, r in enumerate(vt) if r["frame"] == f]
        order = sorted(idx, key=lambda i: -ps[i])
        egg_i = [i for i in idx if vt[i]["label"] == "egg"][0]
        ranks.append(order.index(egg_i) + 1)
    summary[name]["egg_ranks"] = ranks
    print(f"{name:<18} ranks={ranks} top1={sum(r==1 for r in ranks)}/{len(ranks)} top3={sum(r<=3 for r in ranks)}/{len(ranks)}")

print("\n=== Agnes-judged subset (identical items) ===")
for scope, sub in [("test", by["test"]), ("all", rows)]:
    jud = [r for r in sub if r["agnes_egg"] is not None]
    if not jud: continue
    ya = np.array([1 if r["label"] == "egg" else 0 for r in jud])
    ag = np.array([1 if r["agnes_egg"] else 0 for r in jud])
    line = f"{scope}: n={len(jud)} Agnes acc={accuracy_score(ya, ag):.3f} | majority={max(ya.mean(),1-ya.mean()):.3f}"
    for name, P in arms.items():
        if name in ("majority",): continue
        if scope == "test": ps = np.array([P["test"][by["test"].index(r)] for r in jud])
        else:
            allp = np.concatenate([P["train"], P["val"], P["test"]])
            allrows = by["train"] + by["val"] + by["test"]
            ps = np.array([allp[allrows.index(r)] for r in jud])
        line += f" | {name}={accuracy_score(ya, (ps>=0.5).astype(int)):.3f}"
    print(line)

print("\n=== Abstention (test): acc @ coverage ===")
for name in arms:
    a = summary[name]["abstain"]
    print(f"{name:<18} " + "  ".join(f"τ{t}: {v['acc'] if v['acc'] is not None else float('nan'):.2f}@{v['coverage']:.2f}" for t, v in a.items()))

# LR latency
t0 = time.perf_counter()
for r in by["test"][:100]: _ = lr.predict_proba(sc.transform(X([r])))[:, 1]
summary["lr_latency_ms"] = (time.perf_counter() - t0) * 10
print(f"\nLR latency single-item: {summary['lr_latency_ms']:.2f} ms")
json.dump(summary, open(ROOT / "results/bakeoff_summary.json", "w"), indent=1, default=float)
print("wrote results/bakeoff_summary.json")
