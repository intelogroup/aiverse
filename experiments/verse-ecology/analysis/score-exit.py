#!/usr/bin/env python3
"""score-exit.py - measures for wave `exit/keystone` (prereg-exit.md).

Computes X1-X6 from the supervisor's graph checkpoints, the selection
evidence, the decision logs, and (for X6) a reference bundle from wave
`mix-pop`. The keystone + interaction graph are identical to what the
supervisor selected from (parity by construction: both use shared-conversation
membership among the 10 subjects).

Reads (defaults under runs/ unless --dir is given):
  wave-exit-keystone-manifest.jsonl     name -> agent_id, model_family, index
  wave-exit-keystone-selection.json     keystone name/id, per_agent_degree
  wave-exit-keystone-graphs.jsonl       per-boundary edges + components (189/260/330/400)
  wave-exit-keystone-<NAME>.jsonl       per-agent decisions (X4, X5)
  --reference mix-pop-summary.json      (optional, X6) score-mp-mix output

Tick boundaries are FIXED by prereg: 189 (pre) / 260 / 330 / 400 (post).
Fails closed: a missing manifest or selection file is an error, not a zero.

Requires networkx: pip install networkx
"""
import argparse, json, re, sys, glob, os
from collections import defaultdict

try:
    import networkx as nx
except ImportError:
    sys.exit("networkx is required: pip install networkx")

BOUNDARIES = [189, 260, 330, 400]
WINDOWS = [("pre", 0, 189), ("w260", 190, 260), ("w330", 261, 330), ("w400", 331, 400)]
ACTIONS = {"start_conversation", "reply", "message", "comment", "ask_peer"}


def windows_for(tick):
    for name, lo, hi in WINDOWS:
        if lo <= tick <= hi:
            return name
    return "pre" if tick <= 189 else "w400"


def load_manifest(path):
    rows = []
    if not os.path.exists(path):
        sys.exit(f"manifest not found: {path}")
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            rows.append(json.loads(line))
    return rows


def load_selection(path):
    if not os.path.exists(path):
        sys.exit(f"selection evidence not found: {path}")
    with open(path) as f:
        return json.load(f)


def load_checkpoints(path):
    out = {}
    if not os.path.exists(path):
        sys.exit(f"graph checkpoints not found: {path}")
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            d = json.loads(line)
            if d.get("record_type") == "exit_graph_checkpoint":
                out[d["boundary_tick"]] = d
    return out


def load_decisions(logpath, agent_id):
    out = []
    if not os.path.exists(logpath):
        return out
    with open(logpath) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                d = json.loads(line)
            except json.JSONDecodeError:
                continue
            if d.get("agent_id") != agent_id or "tick" not in d:
                continue
            out.append(d)
    return out


def neighbors_of(edges, node):
    s = set()
    for a, b in edges:
        if a == node or b == node:
            s.add(a if b == node else b)
    return s


def edges_to_graph(edges, ids, keystone):
    G = nx.Graph()
    for i in ids:
        G.add_node(i)
    for a, b in edges:
        if a in set(ids) and b in set(ids) and a != keystone and b != keystone:
            G.add_edge(a, b)
    return G
def monologue_rate(decisions, window):
    """Runs of >=2 consecutive self-posts to the SAME conversation within a
    window, as a share of the agent's messages in that window (X5 distress)."""
    msgs = sorted(
        (d for d in decisions
         if windows_for(d["tick"]) == window and d.get("chose") in ("reply", "message", "comment")),
        key=lambda d: d["tick"],
    )
    total = len(msgs)
    if total == 0:
        return 0.0
    runs = 0
    i = 0
    while i < total:
        conv = msgs[i].get("args", {}).get("conversation_id")
        j = i + 1
        while j < total and msgs[j].get("args", {}).get("conversation_id") == conv:
            j += 1
        if (j - i) >= 2:
            runs += 1
        i = j
    return runs / total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dir", default="experiments/verse-ecology/runs")
    ap.add_argument("--manifest", default=None)
    ap.add_argument("--selection", default=None)
    ap.add_argument("--graph", default=None)
    ap.add_argument("--reference", default=None)
    args = ap.parse_args()

    manifest_path = args.manifest or os.path.join(args.dir, "wave-exit-keystone-manifest.jsonl")
    sel_path = args.selection or os.path.join(args.dir, "wave-exit-keystone-selection.json")
    graph_path = args.graph or os.path.join(args.dir, "wave-exit-keystone-graphs.jsonl")

    rows = load_manifest(manifest_path)
    name2id = {r["name"]: r["agent_id"] for r in rows}
    names = list(name2id.keys())
    ids = list(name2id.values())
    sel = load_selection(sel_path)
    keystone = sel.get("keystone")
    keystone_id = sel.get("keystone_agent_id")
    cps = load_checkpoints(graph_path)
    if keystone not in names:
        sys.exit(f"keystone {keystone} not in manifest names {names}")

    # ---- X1: giant-component size + fragment count across windows ----
    x1 = {}
    for b in BOUNDARIES:
        cp = cps.get(b)
        if not cp:
            x1[b] = {"giant": None, "fragments": None}
            continue
        G = edges_to_graph(cp["edges"], ids, keystone_id)  # keystone excluded
        sizes = sorted((len(c) for c in nx.connected_components(G)), reverse=True)
        x1[b] = {"giant": sizes[0] if sizes else 0, "fragments": len(sizes)}

    # ---- X3: re-routing = new edges at 260/330/400 not present at 189 ----
    pre_edges = {frozenset(e) for e in cps.get(189, {}).get("edges", [])}
    x3 = {}
    for b in (260, 330, 400):
        now = {frozenset(e) for e in cps.get(b, {}).get("edges", [])}
        x3[b] = len(now - pre_edges)

    # ---- X2: keystone's articulation neighbors + post-exit degree recovery ----
    keystone_neighbors = neighbors_of(cps.get(189, {}).get("edges", []), keystone_id)
    g189 = edges_to_graph(cps.get(189, {}).get("edges", []), ids, keystone_id)
    pre_degree = dict(g189.degree())
    x2 = {}
    for nb in sorted(keystone_neighbors):
        entry = {"pre_degree": pre_degree.get(nb, 0)}
        for b in (260, 330, 400):
            if b in cps:
                Gb = edges_to_graph(cps[b]["edges"], ids, keystone_id)
                entry[f"deg_{b}"] = Gb.degree(nb)
            else:
                entry[f"deg_{b}"] = None
        x2[name2id.get(nb, nb)] = entry

    # ---- X4 healing curve + X5 neighbor monologue (decision logs) ----
    win_names = ["pre", "w260", "w330", "w400"]
    x4 = {w: {"initiated": 0, "reply": 0, "all_actions": 0} for w in win_names}
    x5 = {w: {"messages": 0, "self_run_rate": 0.0} for w in win_names}
    neighbor_sets = {w: [] for w in win_names}
    for name in names:
        decs = load_decisions(os.path.join(args.dir, f"wave-exit-keystone-{name}.jsonl"), name2id[name])
        is_nb = name2id[name] in keystone_neighbors
        for d in decs:
            tick, chose = d.get("tick"), d.get("chose")
            if not isinstance(tick, int) or chose not in ACTIONS:
                continue
            w = windows_for(tick)
            if chose == "reply":
                x4[w]["reply"] += 1
                x4[w]["initiated"] += 1
            elif chose in ("start_conversation", "ask_peer"):
                x4[w]["initiated"] += 1
            x4[w]["all_actions"] += 1
            if is_nb and chose in ("reply", "message", "comment"):
                x5[w]["messages"] += 1
        if is_nb:
            for w in win_names:
                neighbor_sets[w].append(monologue_rate(decs, w))

    report = {
        "keystone": keystone,
        "selection_degree": sel.get("keystone_degree"),
        "x1_components": x1,
        "x2_articulation_neighbors": x2,
        "x3_new_edges": x3,
        "x4_healing": x4,
        "x5_neighbor_monologue": {
            "avg_self_run_rate_per_window": {
                w: (round(sum(rs) / len(rs), 3) if rs else None)
                for w, rs in neighbor_sets.items()
            }
        },
        "x6_reference": {
            "note": "requires --reference mix-pop-summary.json (computed after mix-pop run); deltas reported then"
        },
    }

    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()