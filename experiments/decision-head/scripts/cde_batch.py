#!/usr/bin/env python3
"""Jev context experiment (Jim's hypothesis, his go 2026-11-09 12:18):
same 120 held-out items as the A/B (results/cde_items.jsonl, built by
scripts/build_full_context.py), same truth, same question.
  ARM C: Jev, FULL context, structured   -> results/cd_jev_full.jsonl
  ARM D: Jev, FULL context, natural language -> results/cd_jev_nl.jsonl
  ARM E: Luna, FULL context, structured (control; state text identical to C)
         -> results/cd_luna_full.jsonl
Jev: pinned typesafe/jev-1.14 via POST /api/alpha/decisions, the identical
Noul question payload as scripts/ab_batch.py / ab_batch_b.py (never the
~latest alias). Luna: openai/gpt-6-luna chat completions, Arm A's exact
system prompt + question suffix. HARD CAP: $0.25 total across all arms --
the batch stops and reports if approached. Light load only: 6-way
concurrency, arms run sequentially (a checkpoint-build lane shares the box).
"""
import json, time, re, sys, pathlib, threading, urllib.request, urllib.error
from concurrent.futures import ThreadPoolExecutor

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import dynamic_credentials as dc

ROOT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head"
CRED = "custom.openrouter"; HOSTS = ["openrouter.ai"]
LUNA_MODEL = "openai/gpt-6-luna"
JEV_MODEL = "typesafe/jev-1.14"
TOTAL_CAP = 0.25

items = [json.loads(l) for l in open(ROOT / "results/cde_items.jsonl")]
print(f"cde batch: {len(items)} items (eggs {sum(r['label']=='egg' for r in items)})", flush=True)

state = {"cost": 0.0, "lock": threading.Lock(), "dead": False}

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
    except Exception as e:
        return -1, {"_error_body": str(e)[:500]}

def spend(c):
    with state["lock"]:
        state["cost"] += c or 0.0
        if state["cost"] >= TOTAL_CAP: state["dead"] = True
        return state["cost"]

def alive():
    with state["lock"]:
        return not state["dead"] and state["cost"] < TOTAL_CAP

# ---- Jev (identical question payload as Arm B) ------------------------------
JEV_QUESTIONS = {"is_egg": {
    "type": "noul",
    "instructions": "Is this candidate an egg?",
    "criteria": {
        "true": "The candidate is an egg: a small ovoid collectible object.",
        "false": "The candidate is any other object, decoration, or image feature."}}}

def call_jev(state_text):
    def fn(r):
        if not alive(): return None
        t = time.perf_counter(); st, body, attempt = -1, {}, 0
        while attempt < 2:
            attempt += 1
            st, body = post("https://openrouter.ai/api/alpha/decisions", {
                "model": JEV_MODEL, "state": state_text(r), "questions": JEV_QUESTIONS})
            if st == 200: break
            time.sleep(2)
        dt = time.perf_counter() - t
        out = {"frame": r["frame"], "cand_idx": r["cand_idx"], "label": r["label"],
               "agnes_egg": r["agnes_egg"], "latency_s": round(dt, 3), "status": st,
               "attempts": attempt}
        if st == 200:
            a = (body.get("answers") or {}).get("is_egg") or {}
            out["p_egg"] = a.get("noul")
            out["model"] = body.get("model")
            u = body.get("usage") or {}
            out["cost"] = u.get("cost"); out["usage"] = u
        else:
            out["p_egg"] = None; out["error"] = str(body)[:300]
        spend(out.get("cost"))
        return out
    return fn

# ---- Luna (Arm A's exact call pattern) --------------------------------------
LUNA_SYS = ("You are the decision module of an agent hunting collectible eggs in a "
            "3D world. You are given a computer-vision proposer's report on ONE "
            "candidate object. Estimate the probability that the candidate is an egg.")
LUNA_Q = ('\nQuestion: is this candidate an egg? Reply with ONLY a JSON object '
          'like {"p_egg": 0.73} — your probability that it is an egg, 0 to 1.')

def call_luna_full(r):
    if not alive(): return None
    t = time.perf_counter(); st, body, attempt = -1, {}, 0
    while attempt < 2:
        attempt += 1
        st, body = post("https://openrouter.ai/api/v1/chat/completions", {
            "model": LUNA_MODEL, "temperature": 0,
            "messages": [{"role": "system", "content": LUNA_SYS},
                         {"role": "user", "content": r["state_c"] + LUNA_Q}],
            "usage": {"include": True}})
        if st == 200: break
        time.sleep(2)
    dt = time.perf_counter() - t
    out = {"frame": r["frame"], "cand_idx": r["cand_idx"], "label": r["label"],
           "agnes_egg": r["agnes_egg"], "latency_s": round(dt, 3), "status": st,
           "attempts": attempt}
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
    spend(out.get("cost"))
    return out

def run_arm(name, fn, path):
    p = ROOT / path
    p.unlink(missing_ok=True)
    done = []
    t0 = time.time()
    with ThreadPoolExecutor(max_workers=6) as ex:
        for out in ex.map(fn, items):
            if out is None: continue
            done.append(out)
            with open(p, "a") as fh: fh.write(json.dumps(out) + "\n")
            if len(done) % 30 == 0:
                print(f"{name}: {len(done)} done, total spend ${state['cost']:.4f}", flush=True)
    ok = sum(1 for d in done if d["status"] == 200)
    print(f"{name} FINISHED: {len(done)} rows, {ok} ok, {time.time()-t0:.0f}s, "
          f"cumulative spend ${state['cost']:.4f} (cap ${TOTAL_CAP})", flush=True)
    return done

print(f"CLOCK START {time.strftime('%H:%M:%S ET', time.localtime())}", flush=True)
run_arm("ARM C jev-full-structured", call_jev(lambda r: r["state_c"]), "results/cd_jev_full.jsonl")
run_arm("ARM D jev-full-nl", call_jev(lambda r: r["state_d"]), "results/cd_jev_nl.jsonl")
run_arm("ARM E luna-full-structured", call_luna_full, "results/cd_luna_full.jsonl")
print(f"BATCH END: total spend ${state['cost']:.4f} of ${TOTAL_CAP} cap", flush=True)
