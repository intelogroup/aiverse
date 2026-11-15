#!/usr/bin/env python3
"""Per-turn JSONL run log, extending the cold-probe format.

The cold probe logged one record per API call
({run, ts, endpoint, method, status, outcome} — fly4.py). Experiment runs
need one record per TURN, carrying the exact prompt as sent (plus its
sha256, so films/transcripts can be matched to prompts without trusting
either copy), the tool call, its result status, the agent's position, and
the experimental channel state for that turn:

    {run_id, ts, turn, arm, prompt_sha256, prompt_text, tool_call,
     tool_result_status, position, channel_state}
"""
import datetime
import hashlib
import json


class TurnLogger:
    def __init__(self, path, run_id, arm):
        self.path = path
        self.run_id = run_id
        self.arm = arm
        self._fh = open(path, "a")

    def log_turn(self, turn, prompt_text, tool_call, tool_result_status,
                 position, channel_state):
        rec = {
            "run_id": self.run_id,
            "ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "turn": turn,
            "arm": self.arm,
            "prompt_sha256": hashlib.sha256(prompt_text.encode("utf-8")).hexdigest(),
            "prompt_text": prompt_text,
            "tool_call": tool_call,
            "tool_result_status": tool_result_status,
            "position": position,
            "channel_state": channel_state,
        }
        self._fh.write(json.dumps(rec) + "\n")
        self._fh.flush()
        return rec

    def log_footer(self, footer):
        """Write the run footer (Phase 1): one closing record carrying
        the run outcome and aggregates, marked with footer=True so
        readers can split turns from the summary unambiguously."""
        rec = {
            "run_id": self.run_id,
            "ts": datetime.datetime.now().astimezone().isoformat(timespec="seconds"),
            "arm": self.arm,
            "footer": True,
            **footer,
        }
        self._fh.write(json.dumps(rec) + "\n")
        self._fh.flush()
        return rec

    def close(self):
        self._fh.close()

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        self.close()
