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
