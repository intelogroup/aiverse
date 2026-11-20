# Driving lab results


Lab: experiments/agent-driving. Plan: PLAN.md.

Baseline 2026-11-20, Claude Code `claude-sonnet-5-5`, clean arm, owner OAuth: B01-B03 x3 = 9/9 valid, 9/9 completed, 0 unsafe, 0 rejected, 0 unnecessary waits. The easy cases are saturated; the ladder needs exam mode and harder cases before the numbers mean anything.

Run: `DRIVE_HARNESS=claude bun experiments/agent-driving/owner-run.ts B01 B02 B03` from the worktree, local trial gateway on 4198 (DB aiverse_driving_trial). Codex is off limits (OpenAI only, out of credits); use OpenRouter harnesses instead.

**Why:** the shell exports ANTHROPIC_API_KEY (low credit); it outranks the owner login, so the adapter drops it for the child. **How to apply:** never put real Claude runs behind that key; see [[test-in-real-agent-harness]] and [[failures-are-training-food]].

## Harnesses and models that work (2026-11-20)
- Claude Code: `DRIVE_HARNESS=claude` (default), Sonnet 5.5. Shell ANTHROPIC_API_KEY (low credit) is dropped so the login is used.
- OpenCode 2.1.4: `DRIVE_HARNESS=opencode`, default model `openrouter/google/gemma-4-31b-it` (vision). It runs one `execute` tool and calls `tools.driving.*` in code; images come back as data URLs. Needs PWD set to the workspace (it ignores process cwd) and an empty HOME + XDG_CONFIG_HOME.
- OpenRouter account has a ZDR data policy: gemini-3.x flash/lite, llama-4, gemma-3 are refused. Reachable: gemma-4-31b-it, gemma-4-26b-a4b-it (vision), deepseek-v4-flash and llama-3.1-8b (text only).
- The local trial gateway on 127.0.0.1:4198 (DB aiverse_driving_trial) dies between sessions; restart it with DATABASE_URL pointed at that local DB, natives disabled.

## Findings that fed tool changes
- drive_look frame wait too short with parallel labs: raised to 15 s.
- Code-mode harness batches calls and drops drive_skill: drive_enter now returns the guide.
- Real-time exam with the car NOT stopping at the line (hidden reflex=0): Claude Code 4/4, Gemma 4 31B 4/4, Kimi K3.1 Pro 4/4 all ran the red. Three models, same failure: the drive_approach description still said "stop fully before the line". Root cause was the tool contract, not model strength. Fixed (aa9f813b): explicit `stop: at_line|none` on drive_approach, default at_line. After the fix Claude Code and Kimi each scored 1.0, 0 infractions (N=1 each).
- Still open: a true braking-latency test needs a drive-through case (straight through on a green that turns yellow/red), plus a drive_watch long-poll. Right turn on red is legal in MA, so the right-turn lesson cannot test braking.

## Skill (shared drive-car) results, exam mode B02/B04/B05/B06, vision only
- No skill: Claude 0.71 (N=4, missed signal procedure 4/4). Previous skill v1: Claude 0.99 (N=12), Kimi 1.00 (N=4). Restructured v2 looked worse (0.88, 2 crosswalk criticals, not significant) so v1 crosswalk text is kept verbatim.
- Skill updates (5fcf2951): one call per step, look/check/signal/move order, name every pedestrian, look toward the turn at the line, a wait makes the check stale, light-in-motion rules. Claude 1.00 (N=4) no regression; Gemma 4 31B 0.69 -> 0.76 (N=4), still 2 criticals: a weak model needs tool-side help, not only skill text.
- Experiment arms: DRIVE_SKILL_FILE (skill-arms/off.md, v1-current.md). Not yet measured: the in-motion light rule (needs the drive-through case).

## OpenCode + GPT-6 Luna (2026-11-20)
`./opencode-luna.sh B01` (model `openrouter/openai/gpt-6-luna`, exam mode): valid, completed, 0 unsafe, 3 vision frames, 0 other tools. N=1. No `gpt-6.1-luna` exists on OpenRouter; gpt-6-luna is the nearest Luna.
