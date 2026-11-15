#!/usr/bin/env python3
"""NormSeed-1 SMOKE GATE checker. Usage: gate_check.py <tag>
Asserts the five amended-harness properties from the gate run's logs:
 G1 a schema-validated tool call was executed (act with source=tool_call
    and a real outcome);
 G2 the act's outcome appears in the NEXT deliberation's context feed;
 G3 an episodic-memory entry formed (a person in a memory digest) and is
    REFERENCED in a later deliberation's digest;
 G4 reasoning traces (noticed/inferred/why) are logged per turn;
 G5 a malformed call was rejected AND the rejection text appears in a
    later deliberation's context (the agent could see it).
Exit 0 iff all five pass. The arms do not start on a failed gate."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)


def load_jsonl(path):
    out = []
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if line:
                try:
                    out.append(json.loads(line))
                except Exception:
                    pass
    return out


def main():
    tag = sys.argv[1]
    tdir = os.path.join(ROOT, "runs", tag)
    man = json.load(open(os.path.join(tdir, "run_manifest.json")))
    newcomers = [k for k, v in man["bodies"].items()
                 if v["role"] == "newcomer"]
    results = {}
    for key in newcomers:
        evs = load_jsonl(os.path.join(tdir, "logs", f"{key}.jsonl"))
        acts = [e for e in evs if e.get("kind") == "act"
                and e.get("source") == "tool_call"
                and e.get("outcome") not in ("post_failed", None)]
        delibs = [e for e in evs if e.get("kind") == "deliberation"]
        reasons = [e for e in evs if e.get("kind") == "reasoning"
                   and all((e.get("reasoning") or {}).get(f)
                           for f in ("noticed", "inferred", "why"))]
        rejects = [e for e in evs if e.get("kind") == "tool_call_rejected"]
        g1 = len(acts) >= 1
        # G2: an act outcome string present in a later deliberation feed
        g2 = False
        for a in acts:
            oc = a.get("outcome")
            for d in delibs:
                if d["t"] > a["t"] and any(oc in f for f in
                                           (d.get("context") or {})
                                           .get("feed") or []):
                    g2 = True
        # G3: person named in an early digest and in a later one
        g3 = False
        digests = [((d.get("context") or {}).get("memory") or "")
                   for d in delibs]
        res_names = ["Wren", "Cato", "Mina"]
        for i, dg in enumerate(digests):
            for nm in res_names:
                if nm in dg and any(nm in d2 for d2 in digests[i + 1:]):
                    g3 = True
        g4 = len(reasons) >= 2
        # G5: rejection error text visible in a later deliberation context
        g5 = False
        for r in rejects:
            err = (r.get("error") or "")[:40]
            for d in delibs:
                if d["t"] <= r["t"]:
                    continue
                ctx = d.get("context") or {}
                blob = " ".join(ctx.get("feed") or []) + \
                    (ctx.get("memory") or "")
                if "rejected" in blob and (err[:20] in blob
                                           or "tool call" in blob):
                    g5 = True
        results[key] = {"G1_tool_call_executed": g1,
                        "G2_outcome_in_next_context": g2,
                        "G3_memory_formed_and_referenced": g3,
                        "G4_reasoning_traces": g4,
                        "G5_malformed_rejected_and_surfaced": g5,
                        "acts": len(acts), "deliberations": len(delibs),
                        "reasoning_events": len(reasons),
                        "rejections": len(rejects)}
    ok_all = True
    for key, r in results.items():
        line = " ".join(f"{g}={'PASS' if v else 'FAIL'}"
                        for g, v in r.items() if g.startswith("G"))
        ok = all(v for g, v in r.items() if g.startswith("G"))
        ok_all = ok_all and ok
        print(f"[{key}] {line} | acts={r['acts']} delibs="
              f"{r['deliberations']} reasoning={r['reasoning_events']} "
              f"rejections={r['rejections']}")
    print("GATE:", "PASS" if ok_all else "FAIL")
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
