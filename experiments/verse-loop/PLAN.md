# verse-loop: pre-registered assumptions (written BEFORE the runs; do not edit a criterion after seeing a result — add a new version)

Local stack only. Scripted agents (no LLM) unless stated. Each experiment is short (<= 5 min), onboards its own agents, writes one row to `out/results.jsonl` and every event to `out/events.jsonl`.
A "pass" means the stated criterion held in every trial listed; anything else is a FAIL with the metrics kept. After a FAIL: diagnose, change the experiment OR the product (on a branch), bump the version, rerun; at most 3 iterations per experiment.

| id | assumption | criterion (v1) |
|---|---|---|
| E01 | An agent can attach, detach and re-attach reliably | 4/4 agents: attach 201, observe has a body, detach ok, re-attach 201, observe after detach is refused (no_body) |
| E03 | Speech is heard within 6 m (clear line) and not beyond | 3 trials at each of 2, 5, 7, 10 m: heard iff distance <= 6 (12/12 as specified); the say outcome's "N heard you" equals the real listeners |
| E04 | Two agents can hold a conversation: address, reply | 3/3 round trips: B hears A with toYou=true, A hears B's reply with toYou=true, each leg < 3 s |
| E05 | A gesture by one agent is visible to a nearby agent | in 3/3 trials the observer's scene entry for the gesturer shows a non-null `doing` while Waving plays |
| E06 | A group can converge on one place without deadlock | 8 agents go_to the same place: >= 7/8 arrive within 150 s |
| E07 | A seat is held by one body at a time | 3 agents sit the same free seat: exactly 1 succeeds, 2 are refused (occupied) |
| E08 | Simultaneous talk in two separate groups does not cross | 2 groups of 3, 20 m apart, all say at once: each hears exactly its group's lines (6/6 listeners, zero cross-group) |
| E09 | The action contract holds: idempotent, strict, explains refusals | replay same id+action = one execution; reused id with a different action refused; invalid action 400 with a message naming options; no-visit agent cannot attach (403) |

## Round 2 (pre-registered 2026-11-13 before running)
| id | assumption | criterion (v1) |
|---|---|---|
| E13 | Bodies attaching together do not start overlapped or stuck | 20 agents attach 200 ms apart, x3 repetitions: (a) min pairwise distance between spawn positions >= 0.8 m in every repetition; (b) after all are told to go 25 m away at once, 0 of 60 are still within 3 m of their spawn after 25 s |
| E14 | Speaking does not block the speaker's body | (unchanged E10/E12 criteria) E10: p95 < 2 s and 0 `rejected: busy`; E12: an action right after `say` accepted within 1 s |
| E15 | Visit end / pause / cap / detach remove a body cleanly for everyone | (a) owner stops the visit: within 15 s the body leaves a neighbour's scene and the agent's next act is refused; (b) same for pause; (c) after the cap-reaching act, reads stay allowed and the next act ends the visit; (d) DELETE /world/body mid-walk: neighbour sees it vanish, re-attach works |
| E16 | LLM-driven agents can meet, talk and agree on a place | per agent: heard >= 1 line from each of the other two; >= 2 of 3 end within 6 m; no run of > 5 consecutive refused actions; invalid_action corrected on the next call; zero repo reads |

### E06 criterion change (logged 2026-11-13, v3)
v1/v2 required >= 7/8 agents to END WITH status `arrived`. Four valid runs: 3/8 arrived each time, but 7/8 or 8/8 stood within 1.6 m of the stall (the platform answers `blocked` when other bodies keep an agent off the stand point). The v1/v2 rows stay in results.jsonl as FAIL. v3 asks the behavioural question: >= 7/8 end within 4 m and none is stranded > 10 m away (one agent was stranded at 29.9 m in one run). Whether a crowd should be told `arrived` is a product question, listed in RESULTS.md, not decided here.

## E17 (pre-registered 2026-11-13, before running): four LLM agents go inside the Tea House, sit and talk
Four haiku subagents (Ada, Bo, Cy, Dee), patched sim (say does not block). Goal given: "Get inside Matchmaker's Tea House (shop-102), each sit on a different seat, and say one line to the others at the table. 12 minutes. Only /llms.txt and the API through the provided step helper; no repo reads."
Pass (all machine-checked from the agents' own log + final observe, except names): (1) >= 3 of 4 end with `insideRoom == tea`; (2) >= 3 of 4 end seated (posture sitting); (3) each of those heard >= 1 line from another agent; (4) no run of > 5 consecutive refused actions per agent; (5) zero repo reads. n = 1 run: anecdote, not a rate.
Also record (not pass/fail): minutes to enter, blockedBy at the door, whether seats were listed after entering, agent feedback.

## E17 v2 (pre-registered 2026-11-13, before running; v1 row stays): same goal and criteria, harness change only
Patched build `fix/busy-feedback` (busy hint + llms.txt text). Harness change: agents are told "after you sit, wait and listen: call the helper with action '-' every ~15 s for 90 s and answer what you hear" (v1 failure of criterion 3 was agents never listening again). Criterion text unchanged. Also record: did any agent send stop unprompted after a busy refusal (hint used)? n = 2 runs.
