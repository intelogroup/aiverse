#!/usr/bin/env python3
"""Smoke (Arm B re-fire, step 1): ONE Jev call on manifest item 0 to confirm
Jim's allowlist fix took, + ONE cheap Luna call to confirm the catalog id
openai/gpt-6-luna still serves as Luna (Arm B's context-role model)."""
import json, time, sys, pathlib, urllib.request, urllib.error

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import dynamic_credentials as dc

ROOT = pathlib.Path.home() / "workspace/.build-tmp/experiments/decision-head"
CRED = "custom.openrouter"; HOSTS = ["openrouter.ai"]

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

items = [json.loads(l) for l in open(ROOT / "results/ab_items.jsonl")]
r = items[0]
print(f"smoke item: frame={r['frame']} cand_idx={r['cand_idx']} label={r['label']}")

JEV_QUESTIONS = {"is_egg": {
    "type": "noul",
    "instructions": "Is this candidate an egg?",
    "criteria": {
        "true": "The candidate is an egg: a small ovoid collectible object.",
        "false": "The candidate is any other object, decoration, or image feature."}}}

t = time.perf_counter()
st, body = post("https://openrouter.ai/api/alpha/decisions", {
    "model": "typesafe/jev-1.14", "state": r["context"], "questions": JEV_QUESTIONS})
dt = time.perf_counter() - t
print(f"JEV smoke: status={st} latency={dt:.2f}s")
if st == 200:
    a = (body.get("answers") or {}).get("is_egg") or {}
    u = body.get("usage") or {}
    print(f"  model={body.get('model')} p_egg(noul)={a.get('noul')} cost={u.get('cost')} usage={u}")
else:
    print(f"  ERROR BODY: {str(body)[:800]}")

t = time.perf_counter()
st2, body2 = post("https://openrouter.ai/api/v1/chat/completions", {
    "model": "openai/gpt-6-luna", "temperature": 0,
    "messages": [{"role": "user", "content": "Reply with ONLY a JSON object like {\"p_egg\": 0.5} — the probability that a round white object is an egg."}],
    "usage": {"include": True}})
dt2 = time.perf_counter() - t
print(f"LUNA verify: status={st2} latency={dt2:.2f}s")
if st2 == 200:
    u2 = body2.get("usage") or {}
    print(f"  served model={body2.get('model')} cost={u2.get('cost')}")
else:
    print(f"  ERROR BODY: {str(body2)[:500]}")
