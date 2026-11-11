#!/usr/bin/env python3
"""Cold GPT agent: OpenAI chat-completions loop with one bash tool.
Usage: gpt_agent.py <deadline_unix> <prompt>   (cwd = agent dir; AGENT_TOKEN in env)
Writes transcript lines (stream-json-ish) to stdout. Key read at run time from
ugent-app/.env.local, never printed."""
import json, os, re, subprocess, sys, time, urllib.request, urllib.error

deadline, prompt = float(sys.argv[1]), sys.argv[2]
key = re.search(r"^OPENAI_API_KEY=(.+)$", (open(os.path.expanduser("~/Developer/ugent-app/.env.local")).read()), re.M).group(1).strip().strip('"\'')
MODEL = os.environ.get("GPT_MODEL", "gpt-6-luna")
tools = [{"type": "function", "function": {"name": "log", "description": "Append a line to your decisions.jsonl (file='decisions') or memory.md (file='memory'). Use before every world action (decisions) and to keep notes (memory).",
          "parameters": {"type": "object", "properties": {"file": {"type": "string", "enum": ["decisions", "memory"]}, "text": {"type": "string"}}, "required": ["file", "text"]}}},
         {"type": "function", "function": {"name": "read_memory", "description": "Read your memory.md",
          "parameters": {"type": "object", "properties": {}}}},
         {"type": "function", "function": {"name": "bash", "description": "Run a shell command (curl, jq, date available).",
          "parameters": {"type": "object", "properties": {"cmd": {"type": "string"}}, "required": ["cmd"]}}}]
msgs = [{"role": "user", "content": prompt}]

ALLOW = {"curl", "jq", "date", "echo", "printf", "cat"}
def allowed(cmd):
    if "`" in cmd or "$(" in cmd or ".." in cmd: return False
    if re.search(r">\s*/", cmd): return False
    return all((seg.split() or [""])[0] in ALLOW for seg in re.split(r"[;&|\n]+", cmd) if seg.strip())

def log(o): print(json.dumps(o), flush=True)

while time.time() < deadline:
    req = urllib.request.Request("https://api.openai.com/v1/chat/completions", method="POST",
        data=json.dumps({"model": MODEL, "messages": msgs, "tools": tools, "reasoning_effort": "none"}).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {key}"})
    try:
        m = json.load(urllib.request.urlopen(req, timeout=120))["choices"][0]["message"]
    except urllib.error.HTTPError as e:
        log({"type": "error", "error": f"{e.code} {e.read().decode()[:400]}"}); break
    except Exception as e:
        log({"type": "error", "error": str(e)[:300]}); break
    msgs.append(m); log({"type": "assistant", "message": m})
    if not m.get("tool_calls"): break
    for tc in m["tool_calls"]:
        name = tc["function"]["name"]
        if name in ("log", "read_memory"):
            a = json.loads(tc["function"]["arguments"] or "{}")
            f = "memory.md" if name == "read_memory" or a.get("file") == "memory" else "decisions.jsonl"
            if name == "log": open(f, "a").write(a["text"].rstrip("\n") + "\n"); out = "ok"
            else: out = open(f).read()[-4000:] if os.path.exists(f) else "(empty)"
            log({"type": "tool_result", "id": tc["id"], "output": out})
            msgs.append({"role": "tool", "tool_call_id": tc["id"], "content": out}); continue
        try:
            cmd = json.loads(tc["function"]["arguments"])["cmd"]
            if not allowed(cmd): raise PermissionError("command not in allowlist (curl jq date echo printf cat)")
            r = subprocess.run(cmd, shell=True, capture_output=True, text=True, timeout=60)
            out = (r.stdout + r.stderr)[-4000:]
        except Exception as e:
            out = f"error: {e}"
        log({"type": "tool_result", "id": tc["id"], "output": out})
        msgs.append({"role": "tool", "tool_call_id": tc["id"], "content": out})
