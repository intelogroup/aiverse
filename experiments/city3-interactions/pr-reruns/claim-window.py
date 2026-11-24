"""Replay the committed #282 timing with equal per-agent lottery entries."""
import hashlib
import json
from collections import Counter
from pathlib import Path

path = Path(__file__).parent
board = json.loads((path / "pr282-claims.json").read_text())
arrivals = sorted(board["claims"], key=lambda claim: claim["t"])
assert len(arrivals) == len({c["key"] for c in arrivals}) == 15
assert sum(c["won"] for c in arrivals) == 1 and arrivals[0]["won"]
report = {"first_claim": {"eligible_at_award": 1, "winner": arrivals[0]["key"]}}
for seconds in (5, 15, 30, 60):
    eligible = [c for c in arrivals if c["t"] - board["announced_at"] <= seconds]
    winners = Counter()
    for seed in range(3000):
        winner = min(eligible, key=lambda c: hashlib.sha256(f"{seed}:{c['key']}".encode()).digest())
        winners[winner["shard"]] += 1
    report[f"{seconds}s_window"] = {
        "eligible_by_shard": dict(Counter(c["shard"] for c in eligible)),
        "eligible_total": len(eligible),
        "winner_shard_counts_in_3000_seeded_draws": dict(winners),
    }
assert report["60s_window"]["eligible_total"] == 15
print(json.dumps(report, indent=2))
