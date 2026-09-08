#!/usr/bin/env python3
"""score-mp-mix.py — measures for waves `mp-ladder` and `mix-pop` (prereg-mp-mix.md).

Computes the preregistered measures from the wave manifest + decision logs
(+ optional export bundle for message-level ties):

  mp-ladder  M1 reply compliance, M2 clause-action distribution, M4
             time-to-first-action, M5 monologue proxy, M6 parse rate — per ARM
             (arm = index<5 Flat vs >=5 Ladder).
  mix-pop    M1 cross-tier ties (networkx DiGraph), M3 imitation lag (nano
             join_room following a gptoss join), M4 Gini of message volume,
             M5 per-tier compliance sanity check.

Usage:
  python3 score-mp-mix.py --manifest runs/wave-mp-ladder-manifest.jsonl \
      [--export runs/wave-mp-ladder-export.json]

Tiers/arms derive from manifest model_family + agent index-in-name (MPL-1..5
vs MPL-6..10; MXP same). Requires networkx: pip install networkx.

Fails closed: a missing/empty manifest is an error, not a zero.
"""
import argparse, json, math, re, sys
from collections import defaultdict

try:
    import networkx as nx
except ImportError:
    sys.exit("networkx is required: pip install networkx")

WAVE_RE = re.compile(r"wave-([a-z0-9-]+)-")


def gini(values):
    xs = sorted(values)
    n = len(xs)
    if n == 0 or sum(xs) == 0:
        return 0.0
    cum = 0.0
    for i, x in enumerate(xs):
        cum += (i + 1) * x
    return (2 * cum) / (n * sum(xs)) - (n + 1) / n


def load_manifest(path):
    rows = []
    with open(path) as f:
        for line in f:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    if not rows:
        sys.exit(f"empty manifest: {path}")
    return rows


def agent_groups(rows):
    """agent_id -> (group, name). mp-ladder: arm from index in name; mix-pop: tier."""
    wave = WAVE_RE.search(rows[0].get("ecology_wave", "")).group(1)
    groups = {}
    for r in rows:
        m = re.search(r"-(\d+)$", r["name"])
        idx = int(m.group(1)) if m else 0
        if wave == "mp-ladder":
            g = "flat" if idx <= 5 else "ladder"
        elif wave == "mix-pop":
            g = "nano" if idx <= 5 else "gptoss"
        else:
            g = r.get("model_family", "?")
        groups[r["agent_id"]] = (g, r["name"])
    return wave, groups


def load_decisions(manifest_rows):
    """All decision rows across the wave's logs, tagged with agent_id."""
    out = []
    for r in manifest_rows:
        try:
            with open(r["log"]) as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    rec = json.loads(line)
                    if rec.get("record_type"):
                        continue  # fingerprint/backend headers, not decisions
                    rec["_agent"] = r["agent_id"]
                    out.append(rec)
        except FileNotFoundError:
            print(f"warn: missing log {r['log']}", file=sys.stderr)
    return out


def score(manifest_path, export_path):
    manifest = load_manifest(manifest_path)
    wave, groups = agent_groups(manifest)
    decs = load_decisions(manifest)
    per = defaultdict(lambda: {
        "ticks": 0, "inbound_ticks": 0, "reply_on_inbound": 0, "first_action_tick": None,
        "parse_fail": 0, "dist": defaultdict(int), "joins": [], "msgs": 0, "starts": 0,
    })
    G = nx.DiGraph()
    for agent, (g, name) in groups.items():
        G.add_node(agent, group=g, name=name)

    for d in decs:
        agent = d["_agent"]
        s = per[agent]
        s["ticks"] += 1
        chose = d.get("chose")
        s["dist"][chose or "null"] += 1
        if chose in ("malformed_json", "off_grammar", None):
            s["parse_fail"] += 1
        else:
            if s["first_action_tick"] is None and chose not in ("nothing", "observe"):
                s["first_action_tick"] = d.get("tick")
        opp = d.get("opportunities") or {}
        args = d.get("args") or {}
        if (opp.get("conversations_with_inbound") or 0) > 0:
            s["inbound_ticks"] += 1
            if chose in ("reply", "message") and args.get("conversation_id"):
                s["reply_on_inbound"] += 1
        if chose == "join_room" and args.get("room"):
            s["joins"].append((d.get("tick"), args["room"]))
        if chose in ("message", "reply"):
            s["msgs"] += 1
        if chose == "start_conversation" and args.get("participant_ids"):
            s["starts"] += 1
            for target in args["participant_ids"]:
                if target in groups:
                    G.add_edge(agent, target, kind="start")

    # Message-level ties from the export bundle, when provided: DM (2-party)
    # conversations give reply-side edges the decision logs can't resolve.
    msg_vol = defaultdict(int)
    if export_path:
        with open(export_path) as f:
            export = json.load(f)
        senders = defaultdict(set)
        for m in export.get("wave_messages", []):
            senders[m["conversation_id"]].add(m["sender_agent_id"])
            msg_vol[m["sender_agent_id"]] += 1
        for conv, ss in senders.items():
            if len(ss) == 2:  # a DM
                a, b = list(ss)
                if a in groups and b in groups:
                    G.add_edge(a, b, kind="dm")
                    G.add_edge(b, a, kind="dm")

    # ---- group-level aggregation.
    groups_out = {}
    for gname in sorted({g for (g, _) in groups.values()}):
        members = [a for a in groups if groups[a][0] == gname]
        tot = sum(per[a]["ticks"] for a in members)
        if tot == 0:
            continue
        firsts = [v for v in (per[a]["first_action_tick"] for a in members) if v is not None]
        groups_out[gname] = {
            "agents": len(members),
            "reply_compliance": round(sum(per[a]["reply_on_inbound"] for a in members) /
                                      max(1, sum(per[a]["inbound_ticks"] for a in members)), 3),
            "dist": {k: sum(per[a]["dist"][k] for a in members)
                     for k in sorted({k for a in members for k in per[a]["dist"]})},
            "parse_fail_rate": round(sum(per[a]["parse_fail"] for a in members) / tot, 3),
            "avg_first_action_tick": round(sum(firsts) / max(1, len(firsts)), 1),
            "starts": sum(per[a]["starts"] for a in members),
        }

    # ---- cross-tier / graph measures (mix-pop M1, M4).
    edges = list(G.edges(data=True))
    cross = [(u, v) for u, v, _ in edges if groups[u][0] != groups[v][0]]
    same = [(u, v) for u, v, _ in edges if groups[u][0] == groups[v][0]]
    result = {
        "wave": wave,
        "decision_rows": len(decs),
        "groups": groups_out,
        "ties": {
            "cross_tier": len(cross), "same_tier": len(same),
            "cross_tier_pairs": sorted(f"{groups[u][1]}->{groups[v][1]}" for u, v in cross),
            "graph_reciprocity": round(nx.reciprocity(G), 3),
        },
    }
    if export_path:
        vols = [msg_vol.get(a, 0) for a in groups]
        result["stratification"] = {
            "gini_message_volume": round(gini(vols), 3),
            "per_agent_volume": {groups[a][1]: msg_vol.get(a, 0) for a in sorted(groups)},
        }

    # Imitation lag (M3): per room, first gptoss join tick vs nano joins after it.
    if wave == "mix-pop":
        first = {}
        for a in groups:
            for tick, room in per[a]["joins"]:
                cur = first.get(room)
                if cur is None or (tick is not None and tick < cur):
                    first[room] = tick
        lag = []
        for a in groups:
            if groups[a][0] != "nano":
                continue
            for tick, room in per[a]["joins"]:
                ft = first.get(room)
                if ft is not None and tick is not None and tick >= ft:
                    lag.append(tick - ft)
        result["imitation"] = {"nano_joins_after_gptoss": len(lag),
                               "median_lag_ticks": sorted(lag)[len(lag) // 2] if lag else None}
    return result


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--manifest", required=True)
    ap.add_argument("--export", default=None)
    args = ap.parse_args()
    print(json.dumps(score(args.manifest, args.export), indent=2))

