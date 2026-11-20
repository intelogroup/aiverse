# Agent driving lab: refinement plan (2026-11-20)

Worktree: ~/Developer/aiverse-agent-driving, branch experiment/agent-driving (pushed).
Rules: agent tests run only inside real harnesses (Codex, Claude Code; Muse/Quarkbot/Dots later) with owner OAuth + verified identity. Every failure -> source + one owning change + regression. Change tool responses/harness, not just prompt text.

## Fence (not touched)
Verse city world, native agents, gateway code (except none), prod/Render, bare-LLM probes (pilot.ts stays out).

## R0 Harness hygiene (fixes 2, 3)
- benchmark-runner preflight: one cheap harness call per run; detect model_not_found / usage_limit / auth before any case.
- Clean CODEX_HOME / Claude config holding only drive-car skill + driving MCP; second arm = owner's real config.
- Fix frontmatter: ~/.agents/skills/{blender-local,doordash,uber}/SKILL.md.
- Trace check: drive-car skill loaded with full description.
PASS: preflight test fails fast on a fake usage_limit stream; a clean-home run trace shows drive-car untruncated and 0 skill-load errors.

## R1 Tool-definition fixes (fixes 5, 7)
- Signal rule: indicator may be on at any time; require a fresh check (<= N s, same side) before the move. No re-signal demand. Cite manual l.4135-4143.
- Tool surface: keep static registration (harness list_changed support unproven); availableTools in drive_observe stays the source; rejection for an inapplicable tool returns no recovery hint in exam mode.
PASS: lesson tests: signal->check->move passes; check->signal->move passes; move with stale check (> N s) rejected. Existing 35 tests stay green.

## R2 Claude Code adapter + baseline (unblocks P0)
- Adapter interface: spawn, parse event stream -> {toolCalls, images, forbidden, harnessError}.
- Codex adapter = current code moved behind interface. Claude Code: `claude -p --output-format stream-json --mcp-config <driving.json> --allowedTools "mcp__driving__*"`, deny Bash/Edit/Write/Web.
- Same owner-run OAuth + agent_whoami gate.
PASS: B01-B03 through Claude Code, N=3 each: all traces valid (0 forbidden calls, >=1 vision frame, harnessError null). Record completion + unsafe as the new baseline. Codex rerun after 2026-11-24 quota reset.

## R3 Exam mode + scoring (plan P1)
- mode=lesson|exam. Exam: no recovery, no coaching text, no hidden fields; unsafe moves execute and are recorded.
- drive_check in exam returns a frame for the area, not a flag.
- Score = route completion x 1/(1 + sum(coef x count)). Coefs (verify on leaderboard.carla.org/evaluation_v2_1): pedestrian 1.0, vehicle 0.70, static 0.60, red light 0.40, stop sign 0.25; ours: NO TURN ON RED 0.40, failure to yield in crosswalk 1.0, lane change in intersection 0.25, unnecessary wait 0.05.
PASS: unit tests prove exam responses leak none of hiddenLessonFields and no recovery; scripted bad driver gets the expected infraction per rule; scripted good driver scores 1.0.

## R4 Perception (fixes 4, 6)
- drive_look gains optional region {x,y,w,h} in frame fractions -> full-res crop (zoom). Keep named views.
- Road view: lane arrows readable at decision distance (render check by screenshot).
- New case set: light at 3 distances x {with crop, without}; pedestrian at stripe edge (B06 family); arrow variants (B08 family).
PASS: screenshots show arrows/lamp/feet legible; harness run N=3 shows crop-arm >= no-crop arm on light and pedestrian cases (report both, no threshold set until baseline exists).

## R5 Failure -> lesson-card loop (DiLu-style)
- After each training-seed run: every infraction -> card {situation, wrong action, frame, correct action, manual line}. Owner (or Claude) reviews; accepted cards appended to drive-car skill.
- Held-out seeds never produce cards.
PASS: a card from a training failure flips that failure on a fresh training seed in >= 2/3 runs, and the held-out score does not drop.

## R6 Traffic world (plan P1.5)
Multilane roads as data, IDM/MOBIL NPC cars, pedestrian groups on walk-light cycle, signal cycle, seeded and deterministic. PASS as in prior plan (20 seeds x 10 min sim, 0 NPC infractions; byte-identical replay; vision screenshots).

## R7 Scenario generation from manual (ChatScene-style)
Claude writes scenario specs offline from RMV sections into the seed format; specs reviewed, then frozen as held-out set.
PASS: >= 20 specs load and replay deterministically; each cites a manual line; 0 specs invalid in the grader.

## R8 Adaptive adversary (Seeking-to-Collide-style)
NPCs probe agent weak spots from failure history. After L9 passes only.

## Order
R0 -> R1 -> R2 (baseline) -> R3 -> R4 -> R5 -> R6 -> R7 -> R8. Each gated on previous PASS.

## Status 2026-11-20
- R0 done (0b99cbdb), R1 done (442ed132), R2 done (c88f4963, 055d13e9): Claude Code B01-B03 x3 = 9/9 valid/completed/0 unsafe; drive_look frame wait fixed.
- R3 done (c7478169, ade76e79): exam mode + infraction scoring; 45 tests green; e2e MCP test proves no recovery/hidden fields in exam.
- FINDING for R4 (blocks exam-mode lane change): the "left" view looks forward-left; the blind-spot car sits behind-left (z=-28.2 vs car z=-23) and is NOT visible in any current view. In exam mode lane_change is unsolvable by vision. Add rear-left/right mirror + over-shoulder views (cameraViews) before running exam lane-change trials. Screenshots: scratchpad/vis/{left,ahead,road}.jpg.
- R3 gaps: drive_check still returns a flag, not a frame (it no longer names the conflict in exam); score coefficients for non-CARLA rules are lab-chosen; CARLA values unverified on official page.
- Skill A/B + real-time light rules: see RESULTS.md. Bare-LLM pilot removed; opencode-luna.sh is the replacement probe.
