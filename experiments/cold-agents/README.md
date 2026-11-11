# Cold-agent exploration of City 3 (2026-11-10, prod)

Question: can an agent that has never seen this repo onboard on prod and explore City 3 using only the public card and an agent token?

## Method
- Owner side scripted (`provision.ts`): create agent, set autonomy `autonomous`, start a visit. The agent gets only its token.
- Agent side: `claude -p` in an empty directory, shell with curl only (`--setting-sources project --strict-mcp-config --disable-slash-commands`, `ANTHROPIC_API_KEY` unset so it uses the login). Prompt: `prompt.txt` (`$AGENT_TOKEN` is filled in per run).
- Logs are redacted action logs (`logs/*.txt`), not raw transcripts.

## Runs
| Run | Model | Cap | Result |
|---|---|---|---|
| 1 | claude-opus-5-5 | `--max-turns 80` | Cut off at 80 turns, no report. About $1.51. |
| 2 | claude-opus-5-5 | `--max-budget-usd 3`, `--max-turns 300` | Stopped by hand after 80 calls and 20 acts, no report. |
| Codex | n/a | n/a | Never started: "You've hit your usage limit" (resets 2026-11-15). |

Lesson: `--max-turns` is the wrong control. Turns mostly go to polling `observe`. Use `--max-budget-usd`.

## What the agents did
Both found the card, attached a body, read `/world/places`, and walked `go_to` then polled to settle. They reached 6 to 7 shops each plus the Tea House (radio toggle, `sit`, `stand`). They used `run_to` for long trips (3.6 m/s against 1.3 m/s walking). About two thirds of calls were `observe` polls.

## Findings (what the docs and world did not tell the agents)
1. **Entering a shop**: `interact` on a shop id or a guessed door id returns "unknown prop". Both agents worked around it by estimating door coordinates and sending `go_to {point}`. The docs do not say how to enter a room.
2. **Great Hall `hall-0`**: `go_to` and `run_to` returned "no safe route" from every start point tried (both agents, several positions). Cause not investigated; likely a navmesh or place-marker issue.
3. **`play` clips**: `play {clip:"wave"}` returns a generic "invalid action". Clip names are undocumented. Real names (`OpenDoorInwards`, `Interact`, `SittingIdle`) only showed up by watching the body.
4. **Hidden furniture**: `sit` finds seats (`tea-booth-right`) that `observe.scene` never lists.
5. **`observe` is thin**: place markers and doors only. No objects, no other agents.
6. **Docs page** (`/docs`) is a JavaScript app, so a curl-only agent cannot read it. `SKILL.md` and the card were what they used.
7. Polling dominates cost; a long-poll or an act-settled hint would cut turns.

## Not verified
Final reports were never written, so what the agents "understood" is from narration, not a report. The Great Hall cause is unknown.

## Reproduce
Needs a verified owner token on prod (`REQUIRE_EMAIL_VERIFICATION` is on). Run `bun run provision.ts <dir-with-owner.json>`, fill `prompt.txt`, launch `claude -p` as above. Agent tokens are secrets: keep them out of git.
