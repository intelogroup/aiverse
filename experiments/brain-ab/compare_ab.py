#!/usr/bin/env python3
"""E4 Brain A/B comparison: two phase dirs (each already run through
analyze.py -> analysis.json). Emits deltas.md + deltas.json in the out dir.
Usage: compare_ab.py <run25_dir> <run30_dir> <out_dir>"""
import json
import os
import sys


def load(d):
    return json.load(open(os.path.join(d, "analysis.json")))


def main():
    d25, d30, out = sys.argv[1], sys.argv[2], sys.argv[3]
    os.makedirs(out, exist_ok=True)
    a, b = load(d25), load(d30)
    rows = []

    def row(label, va, vb, fmt="{:,}"):
        if isinstance(va, (int, float)) and isinstance(vb, (int, float)):
            d = vb - va
            pct = (100.0 * d / va) if va else float("nan")
            rows.append((label, fmt.format(va), fmt.format(vb),
                         f"{d:+,}", f"{pct:+.1f}%"))
        else:
            rows.append((label, str(va), str(vb), "-", "-"))

    t25, t30 = a["totals"], b["totals"]
    for f in ("acts", "says", "heard", "deliberations", "greets"):
        row(f"total {f}", t25[f], t30[f])
    nu25 = sum(v["name_use_says"] for v in a["per_agent"].values())
    nu30 = sum(v["name_use_says"] for v in b["per_agent"].values())
    row("name-use says (total)", nu25, nu30)
    row("act wall ms median", a["act_wall_ms_median"], b["act_wall_ms_median"])
    row("act wall ms p90", a["act_wall_ms_p90"], b["act_wall_ms_p90"])
    row("observe ms median", a["observe_ms_median"], b["observe_ms_median"])
    row("stall watchdog fires", a["stall_watchdog_fires"], b["stall_watchdog_fires"])
    row("visits died", a["visit_dead_count"], b["visit_dead_count"])
    dist25 = sum(v["distance_m"] for v in a["per_agent"].values())
    dist30 = sum(v["distance_m"] for v in b["per_agent"].values())
    row("total distance m", round(dist25), round(dist30))

    pairs25 = {p["pair"]: p["seconds"] for p in a["top_pairs_seconds"]}
    pairs30 = {p["pair"]: p["seconds"] for p in b["top_pairs_seconds"]}
    all_pairs = sorted(set(pairs25) | set(pairs30),
                       key=lambda p: -max(pairs25.get(p, 0), pairs30.get(p, 0)))

    b25, b30 = a.get("bounty") or {}, b.get("bounty") or {}
    bounty = {
        "run25": {"winner": b25.get("winner"), "n_claims": b25.get("n_claims"),
                  "seen_skew_ms": b25.get("seen_skew_ms")},
        "run30": {"winner": b30.get("winner"), "n_claims": b30.get("n_claims"),
                  "seen_skew_ms": b30.get("seen_skew_ms")},
    }

    per_agent = {}
    for k in a["per_agent"]:
        per_agent[k] = {
            f: (a["per_agent"][k][f], b["per_agent"][k][f])
            for f in ("acts", "says", "heard", "deliberations", "name_use_says")}

    deltas = {"totals_rows": rows, "top_pairs": [
        {"pair": p, "run25_s": pairs25.get(p, 0), "run30_s": pairs30.get(p, 0)}
        for p in all_pairs], "bounty": bounty, "per_agent": per_agent}
    with open(os.path.join(out, "deltas.json"), "w") as f:
        json.dump(deltas, f, indent=1)

    lines = ["# E4 Brain A/B — deltas (Run 1 = agnes-2.5-flash, Run 2 = agnes-3.0-flash)",
             "", "| metric | 2.5-flash | 3.0-flash | delta | % |",
             "|---|---|---|---|---|"]
    for r in rows:
        lines.append("| " + " | ".join(r) + " |")
    lines += ["", "## Top encounter pairs (seconds within 6 m)", "",
              "| pair | 2.5 | 3.0 |", "|---|---|---|"]
    for p in deltas["top_pairs"]:
        lines.append(f"| {p['pair']} | {p['run25_s']} | {p['run30_s']} |")
    lines += ["", "## Bounty", "",
              f"- 2.5-flash: winner={bounty['run25']['winner']}, "
              f"claims={bounty['run25']['n_claims']}, seen skew={bounty['run25']['seen_skew_ms']} ms",
              f"- 3.0-flash: winner={bounty['run30']['winner']}, "
              f"claims={bounty['run30']['n_claims']}, seen skew={bounty['run30']['seen_skew_ms']} ms",
              "", "## Per-agent (2.5 -> 3.0)", "",
              "| agent | acts | says | heard | delibs | name-use |",
              "|---|---|---|---|---|---|"]
    for k, v in per_agent.items():
        lines.append("| {} | {} -> {} | {} -> {} | {} -> {} | {} -> {} | {} -> {} |".format(
            k, *v["acts"], *v["says"], *v["heard"], *v["deliberations"],
            *v["name_use_says"]))
    with open(os.path.join(out, "deltas.md"), "w") as f:
        f.write("\n".join(lines) + "\n")
    print("\n".join(lines))


if __name__ == "__main__":
    main()
