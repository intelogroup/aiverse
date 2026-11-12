# Vision pipeline — where the passed experiment verdicts live

The egg-hunt optimization runs (42 Agnes calls, $0) fitted a vision pipeline
for verse agents. When the senses were wired into the production body API
(2026-11-11: gateway `POST /world/see` + this service's hardening), each
verdict was placed where it architecturally belongs — not all of them live
in the capture path, and forcing them there would have been wrong.

| Verdict | Home | Status |
|---|---|---|
| Warm persistent page — KEEP (biggest win: cold 37.9 s → ~11.6 s/look steady in the rig; service median ~55 s on the 1.5-CPU sandbox) | **This service**: one Chromium page, world loaded once, held warm for the process's life | Inherent in the design; unchanged |
| Single-pass depth — KEEP (frame + depth from one render) | **Capture path**: `__scout.look()` returns the PNG and the depth array from the same ScoutVision pass; `depth_summary()` reduces it service-side | Already the shipped behaviour |
| Depth as localizer — KEEP (depth locates, it does not detect) | **Service response**: the depth summary (median, centreMedian, validFrac) rides with every frame, so a caller can locate what the VLM names | Already shipped in /look responses; forwarded by /world/see as `depthSummary` |
| CV pre-filter ≤ ~10 m — KEEP | **Agent-side decision code**, not the service: the cheap local check that decides whether a look is worth firing at all (depth/geometry gate before any VLM call) | Embodied in `test_agent.py`'s decision discipline (proprioception + published data first, look last). Each agent harness owns its own pre-filter; the service must not silently drop requested frames |
| Foveated confirm — KEEP (wide frame → confirm on the centre/aim patch) | **Agent-side decision code**: `test_agent.py`'s two-step check — depth centre-median gate (the centre patch is the fovea of the depth summary), then Agnes confirms | Experiment-side by design; production agents replicate the pattern with the frame + depthSummary /world/see returns |
| Depth for detection — DROP | Nowhere: nothing in the service or the gateway claims a detection from depth alone | Honoured (no such code) |
| Resolution cut — DROP | Nowhere: captures stay 512x288 | Honoured |
| Jev-for-images | NO SEAT (settled 2026-11-11, both resolutions) | Not present, do not add |

Sensorium bounds that shape all of this: a frame is EVIDENCE, not an
answer (the oracle scene is discarded inside the service); position claims
from a sighting carry σ ≈ 0.32 × range and are claim-grade only at
σ2d ≤ 0.75 m; a look is decision-fired, never periodic. Callers consuming
/world/see frames should carry the same uncertainty note into their
deliberation (the social15 driver does).
