#!/usr/bin/env python3
"""E2 homes analyzer. Usage: homes_analyze.py <phase_dir>
Reads tracks/ + logs/ + summary.json + homes.json; writes analysis2.json.
Measures: claims, per-agent time inside each cabin, entries, owner/guest
co-presence inside, invitations spoken, heard-while-inside."""
import json
import os
import re
import sys

KEYS = ["mara", "deshawn", "ingrid", "tomas", "priya", "kenji", "fatima",
        "oleg", "lucia", "amara", "henrik", "yuki", "rafael", "ngozi", "sam"]
ROOMS = {"Stone Cabin": "house-cabin-1",
         "Lakeside Cabin": "house-cabin-2",
         "Zen Tea Pavilion": "house-zen-pavilion-1"}
INVITE = re.compile(r"come|visit|my (home|place|cabin|pavilion)|over to|"
                    r"stop by|welcome|guest|invite", re.I)


def load_jsonl(path):
    out = []
    if os.path.exists(path):
        for line in open(path):
            try:
                out.append(json.loads(line))
            except Exception:
                pass
    return out


def main():
    d = sys.argv[1]
    homes = json.load(open(os.path.join(d, "homes.json")))
    owner_of = {cid: v["owner"] for cid, v in homes.items()}
    summary = json.load(open(os.path.join(d, "summary.json")))

    # per-agent inside intervals per room from pose ticks (~4 s cadence)
    inside = {k: {r: 0.0 for r in ROOMS} for k in KEYS}
    entries = {k: {r: 0 for r in ROOMS} for k in KEYS}
    presence = {k: [] for k in KEYS}   # (t, room or None)
    for k in KEYS:
        ticks = [e for e in load_jsonl(os.path.join(d, "tracks", k + ".jsonl"))
                 if e.get("kind") == "pose"]
        prev_room = None
        prev_t = None
        for e in ticks:
            room = e.get("insideRoom")
            t = e["t"]
            if prev_room in ROOMS and prev_t is not None:
                inside[k][prev_room] += min(t - prev_t, 12)
            if room in ROOMS and prev_room != room:
                entries[k][room] += 1
            presence[k].append((t, room))
            prev_room, prev_t = room, t

    # guest co-presence: for each cabin, seconds a non-owner was inside
    # while the owner was also inside (sampled on guest ticks)
    guest_hosted_s = {cid: 0.0 for cid in ROOMS.values()}
    guest_solo_s = {cid: 0.0 for cid in ROOMS.values()}
    owner_home_s = {cid: 0.0 for cid in ROOMS.values()}
    for cid_room, cid in ROOMS.items():
        owner = owner_of.get(cid)
        owner_ticks = presence.get(owner, []) if owner else []
        for k in KEYS:
            ticks = presence[k]
            for (t, room), (t2, _) in zip(ticks, ticks[1:]):
                if room != cid_room:
                    continue
                dur = min(t2 - t, 12)
                if k == owner:
                    owner_home_s[cid] += dur
                else:
                    owner_in = any(abs(t - ot) <= 8 and oroom == cid_room
                                   for ot, oroom in owner_ticks)
                    if owner_in:
                        guest_hosted_s[cid] += dur
                    else:
                        guest_solo_s[cid] += dur

    claims, invites, heard_inside = [], [], 0
    for k in KEYS:
        for e in load_jsonl(os.path.join(d, "logs", k + ".jsonl")):
            if e.get("kind") == "home_claim":
                claims.append({"agent": k, **e})
            elif e.get("kind") == "say_sent" and INVITE.search(e.get("text") or ""):
                invites.append({"agent": k, "text": e["text"]})
    for k in KEYS:
        ticks = presence[k]
        heard_here = 0
        logs = load_jsonl(os.path.join(d, "logs", k + ".jsonl"))
        for e in logs:
            if e.get("kind") == "heard":
                t = e["t"]
                room = None
                for (tt, rr) in ticks:
                    if tt <= t:
                        room = rr
                    else:
                        break
                if room in ROOMS:
                    heard_here += 1
        heard_inside += heard_here

    out = {
        "owners": owner_of,
        "claims": claims,
        "cabins_claimed": sum(1 for v in owner_of.values() if v),
        "owner_seconds_inside_own": {
            cid: round(inside[owner][room], 0) if owner else 0
            for room, cid in ROOMS.items() for owner in [owner_of.get(cid)]},
        "guest_hosted_seconds": {c: round(v) for c, v in guest_hosted_s.items()},
        "guest_solo_seconds": {c: round(v) for c, v in guest_solo_s.items()},
        "entries_per_agent": {k: entries[k] for k in KEYS
                              if any(entries[k].values())},
        "inside_seconds_per_agent": {
            k: {r: round(s) for r, s in inside[k].items() if s > 0}
            for k in KEYS if any(inside[k].values())},
        "invitations": invites,
        "heard_events_while_inside_cabins": heard_inside,
        "totals": {f: sum(summary[k][f] for k in summary)
                   for f in ("acts", "says", "heard", "deliberations")},
    }
    with open(os.path.join(d, "analysis2.json"), "w") as f:
        json.dump(out, f, indent=1)
    print(json.dumps(out, indent=1))


if __name__ == "__main__":
    main()
