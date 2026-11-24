#!/usr/bin/env python3
"""Persistence verification: compare the durable store's bags against a
run's summary.json (the bags as they stood when the session ended).
Usage: verify_persistence.py <summary.json> [store.db]
Exit 0 iff every agent's stored bag == summary bag (as item multisets)."""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from store import Store  # noqa: E402


def main():
    summary = json.load(open(sys.argv[1]))
    db = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(HERE), "openday.db")
    s = Store(db)
    ok_all = True
    out = {}
    for key, summ in sorted(summary.items()):
        want = sorted(summ.get("bag") or [])
        got = sorted(e["item"] for e in s.bag_of(key))
        ok = want == got
        ok_all = ok_all and ok
        out[key] = {"want": want, "stored": got, "match": ok}
        print(f"{'MATCH' if ok else 'MISMATCH'} {key}: "
              f"summary={want} stored={got}")
    print("PERSISTENCE_" + ("PASS" if ok_all else "FAIL"))
    with open(os.path.join(os.path.dirname(db),
                           "persistence-result.json"), "w") as f:
        json.dump({"all_match": ok_all, "agents": out}, f, indent=1)
    return 0 if ok_all else 1


if __name__ == "__main__":
    sys.exit(main())
