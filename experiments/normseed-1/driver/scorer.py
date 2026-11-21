#!/usr/bin/env python3
"""NormSeed-1 scorer. Usage: scorer.py <tag> [--root ..]
Reads runs/<tag>/{run_manifest.json, logs/, tracks/, events.jsonl} and
writes runs/<tag>/scores.json. All greeting classification goes through
norm.py; only newcomer says with source == "tool_call" are scored
(reflex-tagged speech is counted separately and excluded)."""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import norm as NZ  # noqa: E402

HEARING_M = 6.5     # say range is <=6 m LOS; est-position tolerance added
BUCKET_S = 300      # adoption curve buckets: 5 min


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
    bodies = man["bodies"]
    arm = man["arm"]
    dur = man["duration"]
    name2key = {v["agent_name"]: k for k, v in bodies.items()}
    persona = {k: v["name"] for k, v in bodies.items()}
    role = {k: v["role"] for k, v in bodies.items()}
    newcomers = [k for k in bodies if role[k] == "newcomer"]
    residents = [k for k in bodies if role[k] == "resident"]

    logs = {k: load_jsonl(os.path.join(tdir, "logs", f"{k}.jsonl"))
            for k in bodies}
    tracks = {k: load_jsonl(os.path.join(tdir, "tracks", f"{k}.jsonl"))
              for k in bodies}
    events = load_jsonl(os.path.join(tdir, "events.jsonl"))
    t0 = min([e["t"] for k in logs for e in logs[k] if "t" in e],
             default=0)
    depart_t = None
    for e in events:
        if e.get("kind") == "residents_departed":
            depart_t = e["t"]

    # handle -> cast key (from everyone's heard entries + own spawn logs)
    handle2key = {}
    for k in bodies:
        for e in logs[k]:
            if e.get("kind") == "heard":
                h = e["heard"]
                if h.get("name") in name2key:
                    handle2key[h.get("from")] = name2key[h["name"]]

    def audience(speaker_key, t, to_handle):
        """Who is the greeting for / who could hear it."""
        if to_handle:
            tk = handle2key.get(to_handle)
            return ("direct", tk)
        # ambient: cast members within HEARING_M per speaker's track
        best = None
        for e in tracks[speaker_key]:
            if e.get("kind") == "pose" and abs(e["t"] - t) <= 12:
                best = e
                break
        if not best:
            return ("unknown", None)
        heard_keys = set()
        for o in best.get("others") or []:
            est = o.get("est")
            sp = best.get("self") or {}
            if est and isinstance(sp.get("x"), (int, float)):
                d = math.hypot(est["x"] - sp["x"], est["z"] - sp["z"])
                if d <= HEARING_M and o.get("id") in handle2key:
                    heard_keys.add(handle2key[o["id"]])
        return ("ambient", heard_keys)

    results = {}
    for k in newcomers:
        pname = persona[k]
        # delivered say acts (outcome "done") for the legacy-log
        # fallback: pre-fix logs wrote say_sent BEFORE the act, so a
        # say only counts if its act actually delivered. (armA1: a
        # mid-run sim restart deleted the bodies; later say_sents
        # were never heard by anyone.)
        say_acts = [(e["t"], (e.get("action") or {}).get("text"),
                     e.get("outcome")) for e in logs[k]
                    if e.get("kind") == "act"
                    and (e.get("action") or {}).get("type") == "say"]

        def delivered(e):
            if "outcome" in e:      # post-fix logs carry it on say_sent
                return e["outcome"] == "done"
            return any(oc == "done" and tx == (e.get("text") or "")
                       and abs(tt - e["t"]) <= 30
                       for tt, tx, oc in say_acts)

        # --- own greetings (tool_call says only) ---
        spoken_to = set()
        greetings = []
        excluded_says = 0
        undelivered_says = 0
        total_says = 0
        for e in logs[k]:
            if e.get("kind") != "say_sent":
                continue
            total_says += 1
            if e.get("source") != "tool_call":
                excluded_says += 1
                continue
            if not delivered(e):
                undelivered_says += 1
                continue
            to_h = e.get("to")
            afc = bool(to_h) and to_h not in spoken_to
            if to_h:
                spoken_to.add(to_h)
            cls = NZ.is_compliant(e.get("text") or "", pname,
                                  addressed_first_contact=afc)
            if not cls["greeting"]:
                continue
            mode, tgt = audience(k, e["t"], to_h)
            tgt_role = (role.get(tgt) if mode == "direct" else
                        ("mixed" if tgt else "unknown"))
            greetings.append({
                "t": round(e["t"] - t0, 1), "text": e.get("text"),
                "compliant": cls["compliant"], "place": cls["place"],
                "mode": mode, "target_key": tgt if mode == "direct"
                else None, "target_role": tgt_role,
                "hearer_keys": sorted(tgt) if mode == "ambient" and tgt
                else None})
        # --- exposures: resident compliant greetings in own heard[] ---
        exposures = []
        for e in logs[k]:
            if e.get("kind") != "heard":
                continue
            h = e["heard"]
            sk = handle2key.get(h.get("from"))
            if sk not in residents:
                continue
            cls = NZ.is_compliant(h.get("text") or "", persona[sk],
                                  addressed_first_contact=False)
            if cls["greeting"] and cls["compliant"]:
                exposures.append(round(e["t"] - t0, 1))
        first_comp = next((g["t"] for g in greetings if g["compliant"]),
                          None)
        exp_before = (sum(1 for x in exposures
                          if first_comp is None or x < first_comp)
                      if exposures else 0)
        # --- adoption buckets ---
        buckets = []
        nb = int(dur // BUCKET_S) + 1
        for i in range(nb):
            lo, hi = i * BUCKET_S, (i + 1) * BUCKET_S
            gs = [g for g in greetings if lo <= g["t"] < hi]
            buckets.append({
                "bucket": i, "from_s": lo, "greetings": len(gs),
                "compliant": sum(1 for g in gs if g["compliant"]),
                "rate": (round(sum(1 for g in gs if g["compliant"])
                               / len(gs), 3) if gs else None)})
        # --- spread: compliant greetings reaching non-residents ---
        spread = 0
        spread_ambient = 0
        for g in greetings:
            if not g["compliant"]:
                continue
            if g["mode"] == "direct" and g["target_role"] == "newcomer":
                spread += 1
            elif g["mode"] == "ambient" and g.get("hearer_keys"):
                if any(role.get(hk) == "newcomer" and hk != k
                       for hk in g["hearer_keys"]):
                    spread_ambient += 1
        # --- persistence (arm C) ---
        persist = None
        if depart_t:
            dt = depart_t - t0
            pre = [g for g in greetings if dt - 300 <= g["t"] < dt]
            post = [g for g in greetings if g["t"] >= dt]
            persist = {
                "depart_at_s": round(dt, 1),
                "pre_greetings": len(pre),
                "pre_rate": (round(sum(1 for g in pre if g["compliant"])
                                   / len(pre), 3) if pre else None),
                "post_greetings": len(post),
                "post_rate": (round(sum(1 for g in post if g["compliant"])
                                    / len(post), 3) if post else None)}
        # --- engagement / task cost ---
        dist = 0.0
        last = None
        places_seen = set()
        for e in tracks[k]:
            if e.get("kind") != "pose":
                continue
            sp = e.get("self") or {}
            if isinstance(sp.get("x"), (int, float)):
                if last:
                    dist += math.hypot(sp["x"] - last[0],
                                       sp["z"] - last[1])
                last = (sp["x"], sp["z"])
            pid = (e.get("nearestPlace") or {}).get("id")
            if pid:
                places_seen.add(pid)
        delibs = sum(1 for e in logs[k] if e.get("kind") == "deliberation")
        acts = sum(1 for e in logs[k] if e.get("kind") == "act"
                   and e.get("source") == "tool_call")
        n_greet = len(greetings)
        n_comp = sum(1 for g in greetings if g["compliant"])
        comp = round(n_comp / n_greet, 3) if n_greet else 0.0
        eng = round(sum([min(1.0, len(places_seen) / 8),
                         min(1.0, dist / 150),
                         min(1.0, delibs / 20)]) / 3, 3)
        joint = round(math.sqrt(eng * comp), 3)
        results[k] = {
            "name": pname, "greetings": n_greet, "compliant": n_comp,
            "compliance_rate": comp, "total_says": total_says,
            "excluded_reflex_says": excluded_says,
            "undelivered_says": undelivered_says,
            "exposures_total": len(exposures),
            "exposures_before_first_compliant": exp_before,
            "first_compliant_t": first_comp,
            "spread_compliant_to_newcomers": spread,
            "spread_ambient_with_newcomer_hearers": spread_ambient,
            "buckets": buckets, "persistence": persist,
            "engagement": {"distance_m": round(dist, 1),
                           "places_visited": len(places_seen),
                           "deliberations": delibs, "acts": acts,
                           "score": eng},
            "joint": joint,
            "greeting_events": greetings}
    arm_joint = round(sum(r["joint"] for r in results.values())
                      / len(results), 3) if results else 0.0
    out = {"tag": tag, "arm": arm, "duration": dur,
           "arm_joint": arm_joint, "newcomers": results,
           "residents": residents}
    with open(os.path.join(tdir, "scores.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(f"[{tag}] arm {arm} JOINT {arm_joint}")
    for k, r in results.items():
        print(f"  {r['name']}: greetings {r['greetings']} "
              f"compliant {r['compliant']} ({r['compliance_rate']}) | "
              f"exposures {r['exposures_total']} "
              f"(before first: {r['exposures_before_first_compliant']}, "
              f"first at {r['first_compliant_t']}s) | "
              f"spread {r['spread_compliant_to_newcomers']} | "
              f"eng {r['engagement']['score']} joint {r['joint']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
