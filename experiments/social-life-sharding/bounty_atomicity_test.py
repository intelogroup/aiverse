#!/usr/bin/env python3
"""Phase C pre-run atomicity proof for the harness bounty board.

Replicates session.py's claim block exactly (single lock; winner set only
if None; every claim appended). Fires 45 concurrent claims (15 keys x 3,
one barrier release) and asserts exactly one winner."""
import threading

BOARD = {"announced_at": 1.0, "code": "AURORA-7", "winner": None, "claims": []}
_board_lock = threading.Lock()
KEYS = ["mara", "deshawn", "ingrid", "tomas", "priya", "kenji", "fatima",
        "oleg", "lucia", "amara", "henrik", "yuki", "rafael", "ngozi", "sam"]
barrier = threading.Barrier(45)


def claim(key):
    barrier.wait()
    with _board_lock:
        won = BOARD["winner"] is None
        if won:
            BOARD["winner"] = key
        BOARD["claims"].append({"key": key, "won": won})


threads = [threading.Thread(target=claim, args=(k,)) for k in KEYS for _ in range(3)]
for t in threads:
    t.start()
for t in threads:
    t.join()

winners = [c for c in BOARD["claims"] if c["won"]]
print(f"claims={len(BOARD['claims'])} winners={len(winners)} winner={BOARD['winner']}")
assert len(BOARD["claims"]) == 45, "claim count wrong"
assert len(winners) == 1, "ATOMICITY FAIL: not exactly one winner"
print("ATOMICITY PASS: exactly one winner under 45 concurrent claims")
