#!/usr/bin/env python3
"""Resilient HF download: ModernBERT-base + Laya (pinned rev), retry loop.
HF resumes from .incomplete blobs between attempts."""
import time, sys
from huggingface_hub import snapshot_download

def grab(repo, rev=None):
    for attempt in range(1, 11):
        try:
            p = snapshot_download(repo, revision=rev, max_workers=2)
            print(f"OK {repo} -> {p}", flush=True)
            return p
        except Exception as e:
            print(f"attempt {attempt} failed for {repo}: {type(e).__name__}: {str(e)[:200]}", flush=True)
            time.sleep(15)
    print(f"GIVEUP {repo}", flush=True)
    sys.exit(1)

grab("answerdotai/ModernBERT-base")
print("MB_BASE_OK", flush=True)
grab("convaiinnovations/laya", rev="55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851")
print("LAYA_OK", flush=True)
print("ALL_DOWNLOADS_OK", flush=True)
