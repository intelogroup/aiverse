#!/usr/bin/env python3
"""Batch load watcher (parallel-run recording, Jim's waiver 2026-11-14).

Watches the runs dir while an e1.py batch executes. For every NEW run
file it records /proc/loadavg (1-min) at first sight (run start) and
again when the run's footer record lands (run end), appending JSONL
rows to runs/loads.jsonl keyed by run_id. It never talks to the
gateway and never touches harness code — recording only.

Usage: python3 dev/load_watch.py [runs_dir] [duration_s]
Runs until killed or duration_s elapses.
"""
import glob
import json
import os
import sys
import time

RUNS = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "runs")
DUR = float(sys.argv[2]) if len(sys.argv) > 2 else 0
OUT = os.path.join(RUNS, "loads.jsonl")
T0 = time.time()


def load1():
    with open("/proc/loadavg") as f:
        return float(f.read().split()[0])


def emit(run_id, phase):
    row = {"run_id": run_id, "phase": phase, "ts": round(time.time(), 2),
           "load1": load1()}
    with open(OUT, "a") as f:
        f.write(json.dumps(row) + "\n")


def has_footer(path):
    try:
        with open(path, "rb") as f:
            tail = f.read()[-4096:].decode("utf-8", "replace")
        return '"footer": true' in tail or '"footer":true' in tail
    except OSError:
        return False


def main():
    baseline = {p: os.path.getmtime(p)
                for p in glob.glob(os.path.join(RUNS, "*.jsonl"))
                if not p.endswith("loads.jsonl")}
    started, ended = set(), set()
    while True:
        for p in sorted(glob.glob(os.path.join(RUNS, "*.jsonl"))):
            if p.endswith("loads.jsonl"):
                continue
            run_id = os.path.basename(p)[:-len(".jsonl")]
            if p in baseline and os.path.getmtime(p) <= baseline[p] + 1:
                continue  # pre-existing file, not this batch's
            if run_id not in started:
                started.add(run_id)
                emit(run_id, "start")
            if run_id not in ended and has_footer(p):
                ended.add(run_id)
                emit(run_id, "end")
        if DUR and time.time() - T0 > DUR:
            return
        time.sleep(2)


if __name__ == "__main__":
    main()
