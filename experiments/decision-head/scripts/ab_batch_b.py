#!/usr/bin/env python3
"""ARM B re-fire (2026-11-09, after Jim cleared the OpenRouter allowlist):
Jev-only run over the SAME 120 held-out items Arm A answered, read from the
original manifest results/ab_items.jsonl. Identical serialized contexts,
identical Jev payload as scripts/ab_batch.py (pinned typesafe/jev-1.14,
Decisions API, one Noul question). Caps: Jev $2.00 hard; window ends
2026-11-09 23:59 ET. Prior spend carried in: smoke Jev $0.0000173,
Luna verify $0.000083, Arm A Luna $0.0107537."""
import json, time, sys, pathlib, threading, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import dynamic_credentials as dc

ROOT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head"
CRED = "custom.openrouter"; HOSTS = ["openrouter.ai"]
JEV_MODEL = "typesafe/jev-1.14"
JEV_CAP = 2.00

picked = [json.loads(l) for l in open(ROOT / "results/ab_items.jsonl")]
print(f"arm B: {len(picked)} items from manifest (eggs {sum(r['label']=='egg' for r in picked)})", flush=True)

state = {"jev_cost": 0.0, "lock": threading.Lock(), "dead": False}

def post(url, payload, timeout=120):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("HTTP-Referer", "https://clixen.app"); req.add_header("X-Title", "Clixen")
    dc.add_surrogate_to_request(req, CRED, allowed_hosts=HOSTS)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, dc.read_json_response(resp)
    except urllib.error.HTTPError as e:
        try: body = e.read().decode("utf-8", "replace")
        except Exception: body = "<unreadable>"
        return e.code, {"_error_body": body[:1500]}

JEV_QUESTIONS = {"is_egg": {
    "type": "noul",
    "instructions": "Is this candidate an egg?",
    "criteria": {
        "true": "The candidate is an egg: a small ovoid collectible object.",
        "false": "The candidate is any other object, decoration, or image feature."}}}

def call_jev(r):
    with state["lock"]:
        if state["dead"] or state["jev_cost"] >= JEV_CAP: return None
    t = time.perf_counter()
    st, body = post("https://openrouter.ai/api/alpha/decisions", {
        "model": JEV_MODEL, "state": r["context"], "questions": JEV_QUESTIONS})
    dt = time.perf_counter() - t
    out = {"frame": r["frame"], "cand_idx": r["cand_idx"], "label": r["label"],
           "agnes_egg": r["agnes_egg"], "latency_s": round(dt, 3), "status": st}
    if st == 200:
        a = (body.get("answers") or {}).get("is_egg") or {}
        out["p_egg"] = a.get("noul")
        out["model"] = body.get("model")
        u = body.get("usage") or {}
        out["cost"] = u.get("cost"); out["usage"] = u
    else:
        out["p_egg"] = None; out["error"] = str(body)[:300]
    with state["lock"]:
        state["jev_cost"] += out.get("cost") or 0.0
        if state["jev_cost"] >= JEV_CAP: state["dead"] = True
    return out

t0 = time.time()
print(f"CLOCK START {time.strftime('%H:%M:%S ET', time.localtime())}", flush=True)
done = []
with ThreadPoolExecutor(max_workers=6) as ex:
    for out in ex.map(call_jev, picked):
        if out is None: continue
        done.append(out)
        with open(ROOT / "results/ab_jev.jsonl", "a") as fh: fh.write(json.dumps(out) + "\n")
        if len(done) % 20 == 0:
            print(f"JEV: {len(done)} done, elapsed {(time.time()-t0)/60:.1f} min, jev spend ${state['jev_cost']:.4f}", flush=True)
ok = sum(1 for d in done if d["status"] == 200)
print(f"ARM B FINISHED: {len(done)} items, {ok} ok | elapsed {time.time()-t0:.0f}s | "
      f"jev run spend ${state['jev_cost']:.4f} (cap $2)", flush=True)
