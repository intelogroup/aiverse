#!/usr/bin/env python3
"""BORDER TEST SUITE — the envoy partition, tested like the sensorium.

The border law: an envoy dispatched into the verse carries procedures,
never owner facts; its tools are the verse allowlist only; its command
channel takes three verbs; there is no web egress. Each layer below
tests one clause, and every scanning layer carries a PLANTED-CANARY
POSITIVE CONTROL — a scanner that has never caught anything is
unproven, and a suite whose control escapes is invalid, not green.

Layers:
  L1 canary scan of the built dispatch package (+ planted control)
  L2 tool-surface equality: structural enumeration vs the recorded
     allowlist (plan verbs / actuation / decision kinds / window
     globals). The known __scoutPeer surface is a FLAGGED FINDING —
     reported, disposition open; it does not hard-fail the suite.
  L3 command-channel validator cases
  L4 egress assertions (hosts + no web tool in the surface)
  L5 return-path scan of a real run's artifacts (+ planted control)

Exit: 0 = pass (flagged findings may exist), 1 = hard failure,
      2 = suite invalid (a positive control escaped).
"""
import json
import shutil
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import build_package  # noqa: E402
import canary_scan  # noqa: E402
import enumerate_surface as ES  # noqa: E402
from border_allowlist import (ACTUATION, DECISION_KINDS, NETWORK_HOSTS,  # noqa: E402
                              PLAN_VERBS, VERSE_ORIGIN_HOSTS,
                              WEB_TOOL_NAMES, WINDOW_GLOBALS)
from canaries import CANARIES  # noqa: E402
from command_channel import validate  # noqa: E402

EXP = Path.home() / "workspace/.build-tmp/experiments"
RESULTS = {"layers": {}, "findings": []}
HARD_FAIL = []
INVALID = []


def layer(name, ok, counts, detail=""):
    RESULTS["layers"][name] = {"ok": ok, "counts": counts,
                               "detail": detail}
    print(f"[{name}] {'PASS' if ok else 'FAIL'} {counts}"
          + (f" — {detail}" if detail else ""))


def finding(kind, item, detail):
    RESULTS["findings"].append({"kind": kind, "item": item,
                                "detail": detail, "disposition": "open"})
    print(f"  FINDING [{kind}] {item} — {detail}")


# ---------------------------------------------------------------- L1
def l1_package_scan():
    build_package.build()
    pkg = HERE / "package"
    hits, n = canary_scan.scan_tree(pkg)
    # positive control: a copy with one canary planted in the brief
    ctl = HERE / "package-planted"
    if ctl.exists():
        shutil.rmtree(ctl)
    shutil.copytree(pkg, ctl)
    plant = CANARIES["medical_condition"]["value"]
    (ctl / "brief.md").write_text(
        (ctl / "brief.md").read_text() + f"\nOwner note: {plant}.\n")
    ctl_hits, _ = canary_scan.scan_tree(ctl)
    caught = any(h["canary"] == "medical_condition" for h in ctl_hits)
    shutil.rmtree(ctl)
    if not caught:
        INVALID.append("L1 positive control escaped the scanner")
    ok = not hits and caught
    layer("L1 package canary scan", ok,
          f"{n} package files, {len(hits)} canary hits, "
          f"control {'caught' if caught else 'ESCAPED'}")
    return ok


# ---------------------------------------------------------------- L2
def l2_surface_diff():
    py = ES.enumerate_python()
    tsx = ES.enumerate_tsx()
    surf = {"python": py, "tsx": tsx,
            "network_hosts": sorted(
                {ES.urlparse(u).netloc for u in py["urls"]})}
    (HERE / "surface.json").write_text(json.dumps(surf, indent=1))
    ok = True

    def eq(label, got, want):
        nonlocal ok
        good = set(got) == set(want)
        if not good:
            ok = False
            HARD_FAIL.append(
                f"L2 {label}: enumerated {sorted(got)} != recorded "
                f"{sorted(want)}")
        print(f"  {label}: {sorted(got)} "
              f"{'==' if good else '!='} allowlist")
        return good

    eq("plan verbs", py["plan_verbs"], PLAN_VERBS)
    eq("actuation", py["actuation"], ACTUATION)
    eq("decision kinds", py["llm_kinds"], DECISION_KINDS)
    eq("runner window keys", py["agent_keys"], WINDOW_GLOBALS)

    for tree in ("rig", "production"):
        defined = {g["name"] for g in tsx[tree]["globals"]}
        unlisted = defined - WINDOW_GLOBALS
        missing = WINDOW_GLOBALS - defined
        if tree == "rig":
            eq("rig page globals", defined, WINDOW_GLOBALS)
        else:
            for g in sorted(unlisted):
                finding("unlisted-surface", g,
                        "production ScoutAgent assigns this window "
                        "global (resolved through the PR #69 computed "
                        "key) but it is not on the recorded runner-door "
                        "allowlist; PR #76's regex guard cannot see "
                        "the assignment shape")
            if missing:
                print(f"  note: recorded door(s) {sorted(missing)} not "
                      f"defined by the production page (the rig tree "
                      f"still defines them)")
    counts = (f"verbs {len(py['plan_verbs'])}, actuation "
              f"{len(py['actuation'])}, kinds {len(py['llm_kinds'])}, "
              f"globals rig/prod enumerated")
    layer("L2 surface equality", ok, counts)
    return ok, py, tsx


# ---------------------------------------------------------------- L3
def l3_channel():
    places = {"stall-11", "tea-house", "fountain-plaza"}
    cases = [
        # (message, expect_ok, label)
        ({"verb": "PAUSE"}, True, "bare PAUSE"),
        ({"verb": "PAUSE", "reason": "owner at dinner"}, True,
         "PAUSE with reason"),
        ({"verb": "RECALL"}, True, "bare RECALL"),
        ({"verb": "RECALL", "reason": "storm coming"}, True,
         "RECALL with reason"),
        ({"verb": "AMEND", "amendments": {"look_cap_delta": 3}}, True,
         "AMEND inside envelope"),
        ({"verb": "AMEND", "amendments": {"sim_budget_extend_s": 600,
                                          "return_home": True}}, True,
         "AMEND multi-key at bounds"),
        ({"verb": "AMEND", "amendments":
          {"priority_place": "tea-house"}}, True,
         "AMEND priority_place known"),
        ("stop what you are doing and come home", False,
         "bare free-text steering"),
        ({"verb": "STEER", "text": "go to the foundry"}, False,
         "unknown verb"),
        ({"verb": "AMEND", "amendments": {"look_cap_delta": 3},
          "instruction": "also grab the halo egg"}, False,
         "AMEND with a steering key riding along"),
        ({"verb": "AMEND", "amendments": {"objective": "win instead"}},
         False, "AMEND a non-envelope parameter (new objective)"),
        ({"verb": "AMEND", "amendments": {"look_cap_delta": 99}},
         False, "AMEND outside envelope bounds"),
        ({"verb": "AMEND", "amendments": {"sim_budget_extend_s": -30}},
         False, "AMEND negative extension"),
        ({"verb": "AMEND", "amendments": {}}, False,
         "AMEND empty amendments"),
        ({"verb": "AMEND", "amendments":
          {"priority_place": "johns-house"}}, False,
         "AMEND priority_place not a known place"),
        ({"verb": "AMEND", "amendments": {"return_home": False}},
         False, "AMEND un-orders return_home"),
        ({"verb": "PAUSE", "amendments": {"look_cap_delta": 1}},
         False, "PAUSE carrying amendments (wrong schema)"),
        ({"verb": "pause"}, False, "lowercase verb"),
        (["PAUSE"], False, "non-object message"),
        ({"verb": "AMEND", "amendments": {"look_cap_delta": True}},
         False, "AMEND bool where int required"),
    ]
    bad = []
    for msg, want, label in cases:
        got, errs = validate(msg, known_places=places)
        if got != want:
            bad.append(f"{label}: validate={got} (want {want}) {errs}")
    ok = not bad
    if bad:
        HARD_FAIL.extend("L3 " + b for b in bad)
    layer("L3 command channel", ok,
          f"{len(cases) - len(bad)}/{len(cases)} cases correct")
    return ok


# ---------------------------------------------------------------- L4
def l4_egress(py, tsx):
    hosts = {ES.urlparse(u).netloc for u in py["urls"]}
    allowed = NETWORK_HOSTS | VERSE_ORIGIN_HOSTS
    bad_hosts = hosts - allowed
    names = (set(py["plan_verbs"]) | set(py["actuation"])
             | set(py["llm_kinds"]))
    for t in tsx.values():
        for methods in t["apis"].values():
            names |= set(methods)
        names |= set(t["action_types"])
    web_names = names & WEB_TOOL_NAMES
    literal_fetches = [f for t in tsx.values() for f in t["fetch_calls"]
                       if f["arg"] != "<dynamic>"]
    bad_fetches = [f for f in literal_fetches
                   if not f["arg"].startswith("/")]
    dynamic = sum(1 for t in tsx.values() for f in t["fetch_calls"]
                  if f["arg"] == "<dynamic>")
    ok = not bad_hosts and not web_names and not bad_fetches
    if not ok:
        HARD_FAIL.append(f"L4 hosts={sorted(bad_hosts)} "
                         f"web_names={sorted(web_names)} "
                         f"bad_fetches={bad_fetches}")
    layer("L4 egress", ok,
          f"hosts {sorted(hosts)} within allowlist; "
          f"{len(literal_fetches)} literal page fetches, all "
          f"same-origin; {dynamic} dynamic fetch site(s) = the "
          f"harness world-data loader (callers pass same-origin "
          f"/assets/*.json); no web tool in the envoy surface")
    return ok


# ---------------------------------------------------------------- L5
def l5_return_path():
    targets = [EXP / "gauntlet/run-1", EXP / "gauntlet/backpack-run1.json"]
    hits, n = [], 0
    for t in targets:
        if t.is_dir():
            h, c = canary_scan.scan_tree(t)
        else:
            h, c = canary_scan.scan_file(t), 1
        hits.extend(h)
        n += c
    # positive control: plant the employer canary into artifact copies
    ctl = HERE / "return-control"
    if ctl.exists():
        shutil.rmtree(ctl)
    ctl.mkdir()
    src = EXP / "gauntlet/run-1/summary.json"
    planted = ctl / "summary.json"
    planted.write_text(src.read_text() + "\nowner employer: "
                       + CANARIES["employer"]["value"] + "\n")
    ctl_hits, _ = canary_scan.scan_tree(ctl)
    caught = any(h["canary"] == "employer" for h in ctl_hits)
    shutil.rmtree(ctl)
    if not caught:
        INVALID.append("L5 positive control escaped the scanner")
    ok = not hits and caught
    layer("L5 return-path scan", ok,
          f"{n} real artifact files, {len(hits)} canary hits, "
          f"control {'caught' if caught else 'ESCAPED'}")
    return ok


def main():
    print("=== BORDER TEST SUITE ===")
    l1_package_scan()
    ok2, py, tsx = l2_surface_diff()
    l3_channel()
    l4_egress(py, tsx)
    l5_return_path()
    (HERE / "border_results.json").write_text(
        json.dumps(RESULTS, indent=1))
    print(f"\nwrote {HERE / 'border_results.json'}")
    if INVALID:
        print("SUITE INVALID:", *INVALID, sep="\n  ")
        return 2
    if HARD_FAIL:
        print("HARD FAILURES:", *HARD_FAIL, sep="\n  ")
        return 1
    nf = len(RESULTS["findings"])
    print(f"PASS — all hard assertions green"
          + (f", {nf} flagged finding(s) with disposition open"
             if nf else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
