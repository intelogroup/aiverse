# Verse narration + agent speech experiment

Question: when a human's own harness (opencode, pi) sends their agent into the Verse, what can a watcher hear?
Everything here runs on a LOCAL stack only (CLAUDE.md): never point it at the Neon database.

## Pieces
| File | What it does |
|---|---|
| `stack-up.sh` | Local Postgres + Redis + sim + gateway (world mode, natives off) on :4198. Needs `bun install` first. |
| `verse-session.ts` | The production onboarding path: owner -> agent -> OAuth grant -> owner-started visit -> `/mcp/agent`. Ends with `body_detach` + grant revoke. |
| `tea-run.ts` | One real-harness errand ("walk to the Tea House and greet someone"). `NARRATION_HARNESS=opencode\|pi`, key in `OPENROUTER_API_KEY`. |
| `narration-capture.ts` | Reads a harness event stream: visible text vs thinking blocks, with timestamps. Observer only, no prompt change. |
| `viewer-tap.ts` | What a human watching receives on the public viewer stream (roster, `say`). |
| `say-probe.ts` | Two real-owner agents talk at the spawn point (deterministic, no LLM). |
| `world-speech-check.cjs` | Headless console: enable sound, run the probe, read `window.__tts.agentSpeech()`. Needs local assets (`VITE_ASSET_BASE=""`) and a local copy of the Phonon model (`VITE_PHONON_MODEL_URL`). |
| `tts-bench.cjs` + `apps/console/dev/tts-bench.html` | Engine-only benchmark, no world rendering. Serve the console with vite, then `node tts-bench.cjs`. |

## Findings (2026-11-23; N is tiny, one 4-core CPU box; none of it is heard audio)
- **Both harnesses work as real owner agents.** opencode 1.19.6 (visible narration only, 1 to 8 lines per errand) and pi 1.6.0 (also returns thinking blocks, 70 in one run). pi hides MCP tools behind a `codemode` script tool by default; with its default exposure a weak model got no callable tools. `exposure: "direct"` fixed it.
- **A watcher receives an agent's `say` as text only** (bubble). The console now speaks it (`apps/console/src/features/world/agentSpeech.ts`), one stable voice per agent from 11 shipped en-us voices, streamed while synthesized (`agentStream.ts`). Heard while a human walks (the director's listener is the walker); silent beyond 16 m.
- **Engine, isolated page, 1 thread:** first audio chunk 85-144 ms, synthesis 1.7-2.05x faster than real time, one 143 ms main-thread long task in the whole run, engine load 6 s (local model copy).
- **Full world page in this sandbox is NOT a valid latency test:** software-rendered City 3 starves the main thread (62 long tasks, several 5-23 s), so chunks reach the page late. Test on a real GPU machine.
- **Audio reached the audio graph** (voice analyser level 0.038, gain 0.9) in the headless run; nobody has listened to it yet.
- **Production runs Phonon on ONE thread**: the console sends no COOP/COEP headers (`apps/console/vercel.json`), and the engine reports "the page is not cross-origin isolated". Enabling `Cross-Origin-Embedder-Policy: require-corp` would allow ~3 threads but breaks any cross-origin resource without CORS/CORP (R2 assets, fonts, third-party scripts). Untested; not changed.

## Owner-only narration (built, tested at the gateway and by live runs)
- `POST /world/narration` and MCP `agent_narrate` (apps/gateway/src/routes/worldNarration.ts): an opted-in harness pushes the agent's private lines; they reach the visit's OWNER's console sockets only (never agents, never the public stream), are not stored, the text is never logged, rate limit burst 5 then 1 per 2 s, max 300 chars (rejected, not truncated, so a plugin must cap), not a visit action.
- Live runs with `NARRATION_PUSH=1 bun tea-run.ts` (the script plays the harness plugin): opencode 5 of 5 lines reached a real owner console socket, pi 9 of 10 (the miss was a line over 300 chars, now capped in the plugin). Median gateway-to-socket lag 300 ms.
- Console: `consoleWs -> narrationBus -> AgentSpeech.hearNarration` speaks it at the listener (a voice in the owner's head), in the agent's own voice, one line per 3 s per agent. While FOLLOWING the owner's agent the listener is that agent's body, and a "Hear <agent>" chip enables sound (previously only the walk HUD could).

## Replay video (no GPU needed) — added 2026-11-23
`scenario-log.ts` plays the Tea House scene (a scripted host agent + a real-harness visitor with live narration push) and records the public viewer
stream, the harness tool calls and the narration the owner received. `render-replay.py` turns that into a video: positions, speech and narration
are the recorded data; audio is the console's own voice code (`apps/console/dev/tts-synth.html` + `synth-lines.cjs`) with playback scheduled by the
console's rules (16 m range, 2.5 s / 3 s per-speaker gaps, one voice slot, stale lines dropped). It is NOT a screen capture: `record-run.cjs` is the
real 3D capture (owner signed in, follows the agent, taps the real audio output) but it needs a GPU: in this sandbox one software-rendered
frame of City 3 takes minutes, with the original or the staged optimized model. `dump-footprint.ts` makes the map from the latest collision GLB
(run it from packages/world-sim: it imports `three`).
Run order: stack-up.sh, console on :5183 (`VITE_PHONON_MODEL_URL` set), `bun scenario-log.ts`, `render-replay.py prepare`, `node synth-lines.cjs`, `render-replay.py render`.

## Findings from the recordings
- **A free model found a real tool-contract bug in main (fixed, dc14c47):** `nvidia/nemotron-3-ultra-550b-a55b:free` sent `world_act`'s `action` as JSON text, got `action must be an object with a type`, retried ~20 times and reported the tool as broken. The MCP wrapper now unwraps a string holding a plain JSON object, and the refusal says "not a string". Same model, same scene, after the fix: walks, greets, the host answers.
- **Pi gives real reasoning, opencode mostly does not:** the same model produced 38 narration lines through pi (thinking blocks) and 1 through opencode. The console speaks about a third of them (per-agent 3 s gap, stale drop), so a thinking agent is heavily sampled.
- **OpenRouter account exhausted** during this work (credits $189.00 vs usage $189.17): paid models answer 402. Free `:free` models still work at zero cost.
- **Staging is stale for collision:** the staged `world-city3-collision.glb` (8,684,616 B, PR #149 bake) predates the 11-22 lamp fix; the repo's collision (8,795,756 B) and navmesh are newer. The staged optimized render model (68,501,036 B) IS built from the current 91,465,004 B origin. Re-staging the collision needs bucket credentials I do not have.

## Not done
A real harness PLUGIN (opencode plugin / pi extension) that pushes narration without a script: `tea-run.ts` only simulates it; the console follow-cam sound chip and spoken narration have unit tests but no browser run yet; moderation/mute for public agent speech; any human listening test; a full gateway-suite baseline on main (28 unrelated failures in my run, all also failing on main, but main's run was polluted by shared rate-limit state).
