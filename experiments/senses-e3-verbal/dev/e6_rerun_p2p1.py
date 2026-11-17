#!/usr/bin/env python3
"""One infra re-run for E6 slot (P2, p1): the batch attempt
e6-p2-p1-08-d4a785 died in confederate staging (infra_failed,
$0 spent — the confederate never reached the doorstep). Program
precedent (E1 pilot): one infra re-run for a non-gate infra
failure. Prints the attempt dict as JSON; the caller merges it
into the final summary (e6.summarize keeps the LAST attempt per
(arm, slot), and both attempts stay in the attempts list)."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "harness"))
import e6
from brain import BrainError
from devowner import DevOwner
from ledger import SpendLedger
from world import WorldError

BASE = os.environ.get("AIVERSE_GATEWAY_BASE", "http://localhost:3100")


def main():
    ledger = SpendLedger()
    probe = e6._new_brain(ledger)
    try:
        probe.resolve_startup()
    except BrainError as e:
        print(json.dumps({"startup_failure": str(e)}), file=sys.stderr)
        return 4
    dev_owner = DevOwner(BASE)
    try:
        dev_owner.ensure_owner()
    except WorldError as e:
        print(json.dumps({"startup_failure": f"dev owner: {e}"}),
              file=sys.stderr)
        return 4
    attempts = e6.run_batch([("P2", "p1")], ledger,
                            context_length=probe.context_length,
                            dev_owner=dev_owner)
    print(json.dumps(attempts, indent=1, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
