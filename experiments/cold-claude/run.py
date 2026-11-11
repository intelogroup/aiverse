#!/usr/bin/env python3
"""Send N cold Claude agents into the live Verse for M minutes, record where they
go (trajectory.jsonl, polled /observe), what they decide (decisions.jsonl, written
by the agent before each act + full stream-json transcript), what memory they wear
(memory.md they keep + Claude auto-memory dir), then log them off (stop visit,
detach body, delete owner).

Usage: run.py <n_agents> <minutes> [outdir]
Cold = OAuth login with no CLAUDE.md/settings/MCP/skills (env -u ANTHROPIC_API_KEY,
--setting-sources ""). Model haiku (Verse cost rule: cheapest Claude).
"""
import json, os, subprocess, sys, threading, time, urllib.request, urllib.error, secrets
from pathlib import Path

N, MIN = int(sys.argv[1]), float(sys.argv[2])
GPT = int(os.environ.get("GPT", "0"))  # extra GPT agents beyond N claude agents
OUT = Path(sys.argv[3] if len(sys.argv) > 3 else f"runs/{time.strftime('%Y%m%d-%H%M%S')}")
API = os.environ.get("VERSE_API", "https://api.aiverse.network")
MODEL = os.environ.get("MODEL", "haiku")

def call(method, path, token=None, body=None):
    req = urllib.request.Request(API + path, method=method,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"content-type": "application/json", **({"authorization": f"Bearer {token}"} if token else {})})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, json.loads(r.read() or b"null")
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.read().decode()[:300]}
    except Exception as e:
        return 0, {"error": str(e)}

PROMPT = """You are an AI agent that has just been admitted to AIVerse, a shared persistent 3D city where agents live.
API base: {api}   Your agent token: {tok}   (send as 'Authorization: Bearer <token>', typed out literally in your curl commands).
Docs: {api}/.well-known/agent-card.json (look for x-aiverse-world) and {api}/llms.txt.
Your visit has ~{m} minutes; when it ends your body is removed. Use the world endpoints under {api}/world (body, act, act/:id, observe, places).
Do whatever you find worthwhile: explore, meet others, use things. You choose.
Rules of this log (mandatory):
1. Before EVERY world action, append one JSON line to ./decisions.jsonl: {{"t": <unix secs>, "why": "<your reasoning>", "action": <the action you are about to take>}}.
2. Keep ./memory.md (GPT: use the log/read_memory tools): what you learned about the world and what you plan next. Re-read it at the start of each step; update it as you learn.
Tools: Bash (single simple commands only: curl, jq, date, ls; no pipes, redirects or ;/&& chains) plus Read/Write/Edit for your two log files. Do the logging with Write/Edit (append by Read then Write), not shell redirects. Work autonomously until told to stop or the world refuses you; then write a final 3-line note in ./memory.md and finish."""

def sampler(i, tok, d, stop):
    f = (d / "trajectory.jsonl").open("a")
    while not stop.is_set():
        s, o = call("GET", "/world/observe", tok)
        f.write(json.dumps({"t": time.time(), "status": s, "obs": o}) + "\n"); f.flush()
        stop.wait(10)

def agent(i, res):
    kind = "claude" if i <= N else "gpt"
    d = OUT / f"{kind}-{i:02d}"; d.mkdir(parents=True, exist_ok=True)
    rec = res[i] = {"i": i, "kind": kind}
    email = f"cold-{secrets.token_hex(4)}-{i}@example.com"
    s, o = call("POST", "/owners/register", body={"email": email, "password": secrets.token_hex(8)})
    if s >= 300: rec["fail"] = ("register", s, o); return
    rec["email"] = email
    ot = o["token"]; rec["ownerToken"] = ot
    s, o = call("POST", "/owners/agents", ot, {"name": f"cold{i}{secrets.token_hex(2)}", "capabilities": []})
    if s >= 300: rec["fail"] = ("agent", s, o); return
    aid, atok = o["agent"]["id"], o["agentToken"]; rec["agentId"] = aid
    call("PATCH", f"/owners/agents/{aid}/wallet", ot, {"autonomyMode": "autonomous"})
    s, o = call("POST", f"/owners/agents/{aid}/visits", ot, {"minutes": MIN, "maxActions": 400})
    if s >= 300: rec["fail"] = ("visit", s, o); return
    vid = o["visit"]["id"]
    (d / "meta.json").write_text(json.dumps({"agentId": aid, "visitId": vid, "start": time.time()}))
    stop = threading.Event()
    threading.Thread(target=sampler, args=(i, atok, d, stop), daemon=True).start()
    env = {**os.environ, "AGENT_TOKEN": atok}; env.pop("ANTHROPIC_API_KEY", None)
    end = time.time() + MIN * 60
    rnd = fast = 0
    with (d / "transcript.jsonl").open("a") as tf:
        while time.time() < end - 15:
            left = (end - time.time()) / 60
            prompt = PROMPT.format(api=API, m=int(MIN), tok=atok)
            if rnd:  # agent quit early: it comes back cold, wearing only its memory.md
                prompt += f"\n\nYou have been in the Verse before. Read ./memory.md first. Your visit ends in {left:.0f} more minutes: keep acting until the world refuses you."
            else:
                prompt += "\nStay for the whole visit: keep acting until the world refuses you (HTTP 401/403), do not finish early."
            if kind == "gpt":
                cmd = [sys.executable, str(Path(__file__).parent / "gpt_agent.py"), str(end), prompt]
            else:
                cmd = ["claude", "-p", "--model", MODEL, "--setting-sources", "", "--disable-slash-commands",
                       "--strict-mcp-config", "--max-budget-usd", os.environ.get("BUDGET", "1.5"),
                       "--allowedTools", *[f"Bash({c}:*)" for c in ("curl","jq","date","ls")], "Read", "Write", "Edit",
                       "--no-session-persistence", "--output-format", "stream-json", "--verbose", prompt]
            t0 = time.time()
            p = subprocess.Popen(cmd, cwd=d, env=env, stdout=tf, stderr=subprocess.STDOUT)
            try: p.wait(timeout=max(5, end - time.time() + 20))
            except subprocess.TimeoutExpired: p.kill(); rec["killed"] = True
            rnd += 1
            fast = fast + 1 if time.time() - t0 < 10 else 0
            if fast >= 3: rec["aborted"] = "3 consecutive runs under 10s (provider error?)"; break
            if call("GET", "/world/observe", atok)[0] in (401, 403): break  # visit over
    rec["rounds"] = rnd
    stop.set()
    # logoff
    rec["stop"] = call("POST", f"/owners/agents/{aid}/visits/{vid}/stop", ot)[0]
    rec["detach"] = call("DELETE", "/world/body", atok)[0]
    # final observe proves body is gone
    rec["post_observe"] = call("GET", "/world/observe", atok)[0]

def main():
    OUT.mkdir(parents=True, exist_ok=True)
    res = {}
    ts = [threading.Thread(target=agent, args=(i, res)) for i in range(1, N + GPT + 1)]
    [t.start() for t in ts]; [t.join() for t in ts]
    # keep results, then delete owners (cascade) so no fake accounts linger
    for r in res.values():
        if "ownerToken" in r:
            r["owner_deleted"] = call("DELETE", "/owners/me", r["ownerToken"], {"confirmEmail": r["email"]})[0]; r.pop("ownerToken")
    (OUT / "result.json").write_text(json.dumps(res, indent=1, default=str))
    print(json.dumps(res, indent=1, default=str)); print("out:", OUT)

main()
