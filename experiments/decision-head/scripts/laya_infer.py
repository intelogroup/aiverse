#!/usr/bin/env python3
"""Laya zero-shot arm: the REAL Convai artifact (convaiinnovations/laya,
Apache-2.0, pinned revision), English checkpoint, asked one `noul` question
per candidate: 'Is this candidate an egg?' over the same serialized context
the fine-tuned head sees. Laya never saw our data in training -> zero-shot,
so all splits are fair game; we still report test-split metrics.
Writes results/laya_probs.jsonl with per-item latency.
"""
import json, time, pathlib, sys
import torch
torch.set_num_threads(4)
from laya import Router

ROOT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head"
rows = [json.loads(l) for l in open(ROOT / "data/dataset_a.jsonl")]
only_split = sys.argv[1] if len(sys.argv) > 1 else None
if only_split: rows = [r for r in rows if r["split"] == only_split]
print(f"items: {len(rows)}")

router = Router(default="english", max_loaded=1)
QUESTIONS = {"is_egg": {"type": "noul",
                        "instructions": "Is this candidate an egg?"}}

def ask(context):
    res = router.predict({"candidate_report": context}, QUESTIONS)
    return float(res["answers"]["is_egg"]["noul"])

out = []
t_all = time.perf_counter()
for i, r in enumerate(rows):
    t0 = time.perf_counter()
    try:
        p = ask(r["context"])
    except Exception as e:
        print("ERR", r["frame"], r["cand_idx"], repr(e)[:120]); p = None
    dt = time.perf_counter() - t0
    out.append({"frame": r["frame"], "cand_idx": r["cand_idx"], "split": r["split"],
                "label": r["label"], "p_egg": p, "latency_s": dt})
    if (i + 1) % 50 == 0:
        print(f"{i+1}/{len(rows)}  elapsed {time.perf_counter()-t_all:.0f}s", flush=True)

with open(ROOT / "results/laya_probs.jsonl", "w") as fh:
    for o in out: fh.write(json.dumps(o) + "\n")
ok = [o for o in out if o["p_egg"] is not None]
print(f"done: {len(ok)}/{len(out)} ok, mean latency {sum(o['latency_s'] for o in ok)/max(len(ok),1):.3f}s/item (single-item calls, CPU)")
