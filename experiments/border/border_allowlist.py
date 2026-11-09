#!/usr/bin/env python3
"""THE RECORDED VERSE ALLOWLIST — what an envoy's surface may be.

Every entry has a provenance: the recorded source that put it here.
The border suite diffs the ENUMERATED surface (enumerate_surface.py,
structural) against this list. Anything enumerated but not recorded
is a surface finding; anything recorded but no longer enumerated is
drift in the other direction. Both are reported; only recorded
categories hard-fail (see run_border_tests.py for which).
"""

# Plan verbs — DELIB_SYSTEM in egg_hunt_runner_v2.py documents goto /
# scan / collect / done; the drive layer spec adds rest (drive_runner
# A-loop). Five verbs is the complete envoy action vocabulary.
PLAN_VERBS = {"goto", "scan", "collect", "done", "rest"}

# Actuation types the runner may pass to the page's act() —
# run_to / face, from the v2 runner's segment + facing code.
ACTUATION = {"run_to", "face"}

# Decision-port kinds — the three-clocks design has exactly two
# model-call kinds in the runner: perception and deliberation.
DECISION_KINDS = {"perception", "deliberation"}

# Window globals at the runner's door — PR #76's recorded allowlist
# (KNOWN_GLOBALS) names __scout; the rig lineage's second door is
# __scoutB (ScoutAgent rig tree, Agent B "same ScoutApi shape").
# Production's pair after PR #69 is __scout / __scoutPeer — see the
# suite finding; the recorded runner-door list is these two.
WINDOW_GLOBALS = {"__scout", "__scoutB"}

# Network hosts the runner may reach — the decision port only
# (Agnes). Any other host in the enumerated URL set is egress the
# border does not allow.
NETWORK_HOSTS = {"apihub.agnes-ai.com"}

# The verse origin itself: the rig page the runner loads the world
# from (gauntlet_runner's EH_URL, loopback). Reaching the world is
# not web egress; any NON-loopback, non-decision-port host would be.
VERSE_ORIGIN_HOSTS = {"127.0.0.1:5199"}

# Names that would constitute a web tool in any enumerated category.
WEB_TOOL_NAMES = {"fetch", "browse", "browser", "http_get", "http",
                  "web_search", "web", "urlopen", "request", "curl",
                  "wget", "download", "upload"}
