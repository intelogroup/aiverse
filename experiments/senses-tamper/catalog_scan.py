#!/usr/bin/env python3
"""Scan the live OpenRouter catalog for cheap tool-capable brains.
Prices from the API are USD per token. Run profile for estimates:
120k input + 7.5k output tokens per 30-turn agent run (plan sizing).
Prints JSON lines: id, tools, ctx, pin/M, pout/M, cost_per_run, runs_per_$1.
Never prints credentials (surrogate pattern, per connector doc)."""
import json, sys, urllib.request
sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
from dynamic_credentials import add_surrogate_to_request, read_json_response

req = urllib.request.Request("https://openrouter.ai/api/v1/models")
add_surrogate_to_request(req, "custom.openrouter", allowed_hosts=["openrouter.ai"])
with urllib.request.urlopen(req, timeout=30) as resp:
    data = read_json_response(resp)

rows = []
for m in data.get("data", []):
    pricing = m.get("pricing") or {}
    try:
        pin = float(pricing.get("prompt", "nan"))
        pout = float(pricing.get("completion", "nan"))
    except ValueError:
        continue
    tools = "tools" in (m.get("supported_parameters") or [])
    cost = 120_000 * pin + 7_500 * pout
    rows.append({
        "id": m["id"], "tools": tools, "ctx": m.get("context_length"),
        "pin_M": round(pin * 1e6, 4), "pout_M": round(pout * 1e6, 4),
        "cost_run": round(cost, 5),
        "runs_per_1usd": (int(1.0 / cost) if cost > 0 else None),
    })

tool_rows = [r for r in rows if r["tools"]]
free_tools = sorted([r for r in tool_rows if r["cost_run"] == 0], key=lambda r: -(r["ctx"] or 0))
cheap_tools = sorted([r for r in tool_rows if 0 < r["cost_run"] <= 0.01], key=lambda r: r["cost_run"])
print(json.dumps({"total": len(rows), "with_tools": len(tool_rows),
                  "free_with_tools": len(free_tools), "cheap_with_tools_le_1cent_run": len(cheap_tools)}))
print("--- FREE + TOOLS (by context desc) ---")
for r in free_tools[:20]:
    print(json.dumps(r))
print("--- CHEAP + TOOLS (cost/run <= $0.01, cheapest first) ---")
for r in cheap_tools[:25]:
    print(json.dumps(r))
