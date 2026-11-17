#!/usr/bin/env python3
"""Append-only spend ledger for the agent-senses program.

Jim's rule (plan §11): hard cap $1.00 total for the whole program,
accounted at the brain's ACTUAL prices, enforced from each call's real
usage object. The constants live HERE and nowhere else:

    INPUT_USD_PER_M  = 0.028  (deepseek/deepseek-v4-flash via OpenRouter,
    OUTPUT_USD_PER_M = 0.056   per 1M input / output tokens, plan §11.1)
    SPEND_CAP_USD    = 1.00

(Phase 0 priced the then-planned Agnes route at its list prices,
0.05 / 0.15; Jim's 2026-11-14 model pick replaced them with DeepSeek's
actual OpenRouter prices above. The cap never changed.)

Ledger file: harness/ledger.jsonl, one JSON object per accounted call:
    {ts, model, usage, cost_usd, cumulative_usd}
"""
import datetime
import json
import os

INPUT_USD_PER_M = 0.028
OUTPUT_USD_PER_M = 0.056
SPEND_CAP_USD = 1.00

DEFAULT_LEDGER_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                   "ledger.jsonl")


class HaltError(RuntimeError):
    """Raised when the spend cap has been reached. Batches stop; they
    never silently continue past the cap."""


def cost_for_usage(usage):
    """USD at list prices for an OpenAI/OpenRouter-shaped usage object."""
    prompt = usage.get("prompt_tokens", 0) or 0
    completion = usage.get("completion_tokens", 0) or 0
    return (prompt / 1_000_000 * INPUT_USD_PER_M
            + completion / 1_000_000 * OUTPUT_USD_PER_M)


class SpendLedger:
    def __init__(self, path=DEFAULT_LEDGER_PATH, cap_usd=SPEND_CAP_USD):
        self.path = path
        self.cap_usd = cap_usd

    def entries(self):
        if not os.path.exists(self.path):
            return []
        out = []
        with open(self.path) as f:
            for line in f:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
        return out

    def spent(self):
        """Total accounted spend, reloaded from disk every call."""
        return sum(e["cost_usd"] for e in self.entries())

    def check(self):
        """Raise HaltError if the cap has been reached."""
        s = self.spent()
        if s >= self.cap_usd:
            raise HaltError(
                f"spend cap reached: ${s:.6f} accounted >= ${self.cap_usd:.2f} cap")
        return s

    def account(self, model, usage):
        """Account one completed call. Refuses (HaltError, nothing
        appended) if the cap was already reached before this call."""
        self.check()
        cost = cost_for_usage(usage)
        entry = {
            "ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "model": model,
            "usage": usage,
            "cost_usd": cost,
            "cumulative_usd": self.spent() + cost,
        }
        with open(self.path, "a") as f:
            f.write(json.dumps(entry) + "\n")
        return entry
