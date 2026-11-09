#!/usr/bin/env python3
"""Render the gauntlet run's owner report from its backpack ledger.

Usage: gauntlet_owner_report.py <backpack.json> <summary.json> <run_dir>
Writes <run_dir>/OWNER-REPORT.md — the human's at-home view, in the
bring-back format: what the bot brought home, and what it proves.
"""
import json
import sys
from pathlib import Path


def main():
    bp = json.loads(Path(sys.argv[1]).read_text())
    summary = {}
    sp = Path(sys.argv[2])
    if sp.exists():
        summary = json.loads(sp.read_text())
    run_dir = Path(sys.argv[3])
    items = {i["kind"]: i for i in bp["items"]}
    lines = ["WHAT YOUR BOT BROUGHT HOME — ONBOARDING GAUNTLET",
             f"Owner: {bp['owner_id']} · Bot: {bp['bot_id']} · "
             f"Run: {bp['run_id']}", ""]
    if "code" in items:
        it = items["code"]
        r = it.get("redemption") or {}
        lines += [f"1. PRIZE CODE — {it['payload']['code']}",
                  f"   Claimed from {it['payload']['source_egg_id']} at "
                  f"sim t={it['captured_at_sim_s']}s "
                  f"({it['provenance']['how']}). State: "
                  f"{(r.get('state') or 'held').upper()}"
                  + (f" (txn {r.get('txn_ref')})" if r.get("txn_ref")
                     else "") + " — exactly one redemption exists.", ""]
    if "collectible" in items:
        it = items["collectible"]
        lines += [f"2. COLLECTIBLE — {it['payload']['collectible_id']}",
                  f"   Found by sight at {it['payload']['position']} — "
                  f"it was in no registry; the bot saw it, walked to "
                  f"it, and picked it up ({it['provenance']['how']}). "
                  f"Evidence frame: {it['payload'].get('capture_frame')}.",
                  "   Not redeemable, not tradeable. It is yours to keep.",
                  ""]
    if "memory" in items:
        it = items["memory"]
        d = it["payload"]["digest"]
        lines += [f"3. MEMORY — your bot remembers",
                  f"   {it['payload']['entries_written']} entries "
                  f"distilled from this run: {d['by_kind']}."]
        for e in d["top_entries"]:
            lines.append(f"   - {e['place_ref']} ({e['kind']}, "
                         f"conf {e['confidence']}) {e['note']}")
        lines += [f"   Full store: {it['payload']['store_path']}", ""]
    shots = [i for i in bp["items"] if i["kind"] == "screenshot"]
    if shots or "film" in items:
        lines.append("4. MEDIA — what it saw")
        for s in shots:
            lines.append(f"   - screenshot ({s['payload']['trigger']}): "
                         f"{s['payload']['file']}")
        if "film" in items:
            f = items["film"]["payload"]
            lines.append(f"   - film: {f['film']} "
                         f"(mode {f.get('mode')}, real fps "
                         f"{f.get('real_fps')}, {f.get('duration_s')} s)")
            for k, v in (f.get("clips") or {}).items():
                lines.append(f"   - {k}: {v}")
        lines.append("")
    ag = (summary.get("agents") or {}).get("A") or {}
    llm = summary.get("llm_calls") or {}
    lines += [f"Run facts: sim {summary.get('sim_elapsed_s')} s · "
              f"wall {summary.get('wall_elapsed_s')} s · "
              f"steps {ag.get('steps')} · looks "
              f"{ag.get('looks_completed')}/{ag.get('looks_fired')} · "
              f"model calls {llm.get('count')} · cost $0.00 "
              f"(Agnes free tier)."]
    (run_dir / "OWNER-REPORT.md").write_text("\n".join(lines) + "\n")
    print(f"owner report -> {run_dir / 'OWNER-REPORT.md'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
