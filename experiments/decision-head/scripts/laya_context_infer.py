#!/usr/bin/env python3
"""Laya zero-shot inference over arbitrary item sets and state formats.

Same Router call as scripts/laya_infer.py (the real Convai artifact,
convaiinnovations/laya @ pinned rev, English checkpoint): one `noul`
question 'Is this candidate an egg?' over field 'candidate_report'.
Only the context string changes across arms -- byte-identical states to
what Jev/Luna received are read from results/cde_items.jsonl (the 120) or
results/all_contexts.jsonl (any split).

Usage: laya_context_infer.py ITEMS_JSONL FIELD OUT_JSONL [SPLIT]
  FIELD in {context, state_c, state_d}; SPLIT optional filter.
Resume-safe: items already present in OUT are skipped (append mode), so
an interrupted run continues instead of restarting."""
import json, time, pathlib, sys, os
import torch
torch.set_num_threads(4)
from laya import Router

ROOT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head"
items_path, field, out_path = sys.argv[1], sys.argv[2], sys.argv[3]
only_split = sys.argv[4] if len(sys.argv) > 4 else None
assert field in ("context", "state_c", "state_d")

rows = [json.loads(l) for l in open(items_path)]
if only_split: rows = [r for r in rows if r.get("split") == only_split]
done = set()
if os.path.exists(out_path):
    for l in open(out_path):
        r = json.loads(l); done.add((r["frame"], r["cand_idx"]))
todo = [r for r in rows if (r["frame"], r["cand_idx"]) not in done]
print(f"items total {len(rows)}, already done {len(done)}, to run {len(todo)}", flush=True)

def rss_mb():
    for l in open("/proc/self/status"):
        if l.startswith("VmRSS"): return int(l.split()[1]) / 1024
    return -1

t_load = time.perf_counter()
router = Router(default="english", max_loaded=1)
print(f"router loaded in {time.perf_counter()-t_load:.1f}s, RSS {rss_mb():.0f} MB", flush=True)
QUESTIONS = {"is_egg": {"type": "noul",
                        "instructions": "Is this candidate an egg?"}}

def ask(context):
    res = router.predict({"candidate_report": context}, QUESTIONS)
    return float(res["answers"]["is_egg"]["noul"])

t_all = time.perf_counter()
with open(out_path, "a") as fh:
    for i, r in enumerate(todo):
        t0 = time.perf_counter()
        try:
            p = ask(r[field])
        except Exception as e:
            print("ERR", r["frame"], r["cand_idx"], repr(e)[:160], flush=True); p = None
        dt = time.perf_counter() - t0
        fh.write(json.dumps({"frame": r["frame"], "cand_idx": r["cand_idx"],
                             "split": r.get("split"), "label": r["label"],
                             "p_egg": p, "latency_s": dt, "field": field,
                             "model": "convaiinnovations/laya@55cf4c4"}) + "\n")
        fh.flush()
        if (i + 1) % 25 == 0:
            print(f"{i+1}/{len(todo)} elapsed {time.perf_counter()-t_all:.0f}s RSS {rss_mb():.0f} MB", flush=True)
ok = [json.loads(l) for l in open(out_path)]
ok = [o for o in ok if o["p_egg"] is not None]
print(f"done: {len(ok)} ok rows in {out_path}, mean latency "
      f"{sum(o['latency_s'] for o in ok)/max(len(ok),1):.3f}s/item (single-item calls, CPU)")
