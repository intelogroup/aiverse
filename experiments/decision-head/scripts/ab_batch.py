#!/usr/bin/env python3
"""A/B replay: ARM A Luna alone vs ARM B Luna-state + Jev (typesafe/jev-1.14),
over held-out staged decision items (test split of dataset_a.jsonl — disjoint
from every Laya training/val split). Jim's time-box: 15 min wall from first
call; hard caps: Jev $2.00, combined $5.00, window ends 2026-11-09 23:59 ET.
Every completed item is kept; partial results are the deliverable."""
import json, time, random, re, sys, pathlib, threading, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import dynamic_credentials as dc

ROOT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head"
CRED = "custom.openrouter"; HOSTS = ["openrouter.ai"]
LUNA_MODEL = "openai/gpt-6-luna"
JEV_MODEL = "typesafe/jev-1.14"
JEV_CAP = 2.00; COMBINED_CAP = 5.00; BOX_S = 900
LIMIT = int(sys.argv[1]) if len(sys.argv) > 1 else 120

rows = [json.loads(l) for l in open(ROOT / "data/dataset_a.jsonl")]
test = [r for r in rows if r["split"] == "test"]
eggs = [r for r in test if r["label"] == "egg"]
judged = [r for r in test if r["agnes_egg"] is not None]
key = lambda r: (r["frame"], r["cand_idx"])
picked, seen = [], set()
for r in eggs + judged:
    if key(r) not in seen: picked.append(r); seen.add(key(r))
rest = [r for r in test if key(r) not in seen]
hard = sorted(rest, key=lambda r: -r["ovoid"])[:56]
for r in hard:
    if key(r) not in seen: picked.append(r); seen.add(key(r))
pool = [r for r in test if key(r) not in seen]
random.Random(11).shuffle(pool)
for r in pool:
    if len(picked) >= LIMIT: break
    picked.append(r); seen.add(key(r))
random.Random(3).shuffle(picked)
print(f"batch: {len(picked)} items (eggs {sum(r['label']=='egg' for r in picked)}, "
      f"agnes-judged {sum(r['agnes_egg'] is not None for r in picked)})", flush=True)
with open(ROOT / "results/ab_items.jsonl", "w") as fh:
    for r in picked: fh.write(json.dumps(r) + "\n")

state = {"t0": None, "jev_cost": 0.0, "luna_cost": 0.0, "lock": threading.Lock(),
         "jev_dead": False, "all_dead": False}

def budget(arm):
    with state["lock"]:
        if state["all_dead"]: return False
        if arm == "jev" and (state["jev_dead"] or state["jev_cost"] >= JEV_CAP): return False
        if state["jev_cost"] + state["luna_cost"] >= COMBINED_CAP:
            state["all_dead"] = True; return False
        if state["t0"] is not None and time.time() - state["t0"] > BOX_S: return False
        return True

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

def mark_first():
    with state["lock"]:
        if state["t0"] is None:
            state["t0"] = time.time()
            print(f"CLOCK START {time.strftime('%H:%M:%S ET', time.localtime())}", flush=True)

def add_cost(arm, c):
    with state["lock"]:
        state[arm + "_cost"] += c or 0.0
        if state["jev_cost"] >= JEV_CAP: state["jev_dead"] = True
        if state["jev_cost"] + state["luna_cost"] >= COMBINED_CAP: state["all_dead"] = True

# ---------------- ARM A: Luna alone (chat completions) ----------------------
LUNA_SYS = ("You are the decision module of an agent hunting collectible eggs in a "
            "3D world. You are given a computer-vision proposer's report on ONE "
            "candidate object. Estimate the probability that the candidate is an egg.")
LUNA_Q = ('\nQuestion: is this candidate an egg? Reply with ONLY a JSON object '
          'like {"p_egg": 0.73} — your probability that it is an egg, 0 to 1.')

def call_luna(r):
    if not budget("luna"): return None
    mark_first(); t = time.perf_counter()
    st, body = post("https://openrouter.ai/api/v1/chat/completions", {
        "model": LUNA_MODEL, "temperature": 0,
        "messages": [{"role": "system", "content": LUNA_SYS},
                     {"role": "user", "content": r["context"] + LUNA_Q}],
        "usage": {"include": True}})
    dt = time.perf_counter() - t
    out = {"frame": r["frame"], "cand_idx": r["cand_idx"], "label": r["label"],
           "agnes_egg": r["agnes_egg"], "latency_s": round(dt, 3), "status": st}
    if st == 200:
        txt = body["choices"][0]["message"]["content"] or ""
        m = re.search(r'"p_egg"\s*:\s*([0-9.]+)', txt) or re.search(r'([01](?:\.\d+)?)', txt)
        out["p_egg"] = float(m.group(1)) if m else None
        out["raw"] = txt[:200] if out["p_egg"] is None else None
        u = body.get("usage") or {}
        out["cost"] = u.get("cost"); out["prompt_tokens"] = u.get("prompt_tokens")
        out["completion_tokens"] = u.get("completion_tokens")
        out["model"] = body.get("model")
    else:
        out["p_egg"] = None; out["error"] = str(body)[:300]
    add_cost("luna", out.get("cost"))
    return out

# ---------------- ARM B: Jev (Decisions API) --------------------------------
JEV_QUESTIONS = {"is_egg": {
    "type": "noul",
    "instructions": "Is this candidate an egg?",
    "criteria": {
        "true": "The candidate is an egg: a small ovoid collectible object.",
        "false": "The candidate is any other object, decoration, or image feature."}}}

def call_jev(r):
    if not budget("jev"): return None
    mark_first(); t = time.perf_counter()
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
    add_cost("jev", out.get("cost"))
    return out

def run_arm(name, fn, path):
    done = []
    with ThreadPoolExecutor(max_workers=6) as ex:
        for out in ex.map(fn, picked):
            if out is None: continue
            done.append(out)
            with open(path, "a") as fh: fh.write(json.dumps(out) + "\n")
            if len(done) % 20 == 0:
                print(f"{name}: {len(done)} done, elapsed "
                      f"{(time.time()-state['t0'])/60:.1f} min, costs "
                      f"jev ${state['jev_cost']:.4f} luna ${state['luna_cost']:.4f}", flush=True)
    print(f"{name} FINISHED: {len(done)} items", flush=True)
    return done

threads = [threading.Thread(target=run_arm, args=("LUNA", call_luna, str(ROOT / "results/ab_luna.jsonl"))),
           threading.Thread(target=run_arm, args=("JEV", call_jev, str(ROOT / "results/ab_jev.jsonl")))]
for p in (ROOT / "results/ab_luna.jsonl", ROOT / "results/ab_jev.jsonl"):
    p.unlink(missing_ok=True)
for th in threads: th.start()
for th in threads: th.join()
el = time.time() - state["t0"] if state["t0"] else 0
print(f"BATCH END: elapsed {el:.0f}s | jev spend ${state['jev_cost']:.4f} (cap $2) | "
      f"luna spend ${state['luna_cost']:.4f} | combined ${state['jev_cost']+state['luna_cost']:.4f} (cap $5)", flush=True)
