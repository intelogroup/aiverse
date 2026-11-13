# verse-loop results (local stack, 2026-11-13)

Every iteration is kept in `results/results.jsonl`; the table shows the history per experiment (P = pass, F = fail, in run order) and the last verdict.

| id | assumption (criterion at last version) | history | last |
|---|---|---|---|
| E01 | 4/4 agents attach/detach/re-attach cleanly | PP | PASS |
| E03 | heard iff real distance <= 6 m, 12/12 | PP | PASS |
| E04 | 3/3 addressed round trips (toYou true both ways, each < 3 s) | FP | PASS |
| E05 | observer's `doing` names each of the 3 clips played | FPP | PASS |
| E06 | >= 7/8 arrive at one place within 150 s (v1); v2 adds one retry and records final distance | FF | FAIL |
| E07 | seat held by one body: 2 explicit sits on its id refused; a plain sit picks a different seat | FP | PASS |
| E08 | each of 6 listeners hears its 2 group mates and 0 cross-group lines | FP | PASS |
| E09 | replay idempotent, reused id refused, invalid 400 with options, unclaimed agent refused | PP | PASS |
| E10 | 15 agents x 16 instant acts: p95 < 2 s, no refusals/5xx | FFF | FAIL |
| E11 | back-to-back face acts at 500 ms spacing are never rejected busy (documented ~2 acts/s) | P | PASS |
| E12 | an action issued right after `say` is accepted within 1 s | P | PASS |

## What the failures turned out to be

- **E04, E05, E08 failed first because of the experiments, not the product** (guessing a peer's handle by distance in a crowded spawn; leftover bodies from earlier runs; a criterion that a leftover "Talking" clip satisfied). Fixed by learning handles from `heard[].from`, a clean database per batch, and a strict criterion; all pass.
- **E06 (convergence) fails on product behaviour.** 8 agents sent to one stall: 3 arrive, 5 end `blocked` by the other bodies, but 7/8 stand within 2 m of it. One agent never leaves the crowded spawn ("no progress, 29.9 m out; another body is right beside you") and stays stuck through a retry. `blocked` within 2 m of the target is a crowd that has effectively arrived.
- **E10/E12 (`say` blocks the body).** After a `say`, the same body refuses any other action as `rejected: busy`: 0.86 s for a lone agent (E12), and in a 15-agent run every agent's next two acts after every `say` were refused (probe4: columns 4-5, 8-9, 12-13). The docs call speech non-physical and say a refused action costs nothing, but they do not say that speaking blocks the body. p95 act latency itself is fine (1.2 s at 15 agents).
- **Seats are not listed on entry** (probe3): standing just inside the Tea House, `observe.scene` shows room/place/door and no `seat` objects, although the guide says a shop lists them; `sit` with no id still works (E07).
- **Bulk onboarding is slow by design:** the claim limiter is 5 per IP then one per 180 s (`owners.ts`), so 15 agents from one IP take about 30 minutes. The harness clears the local bucket; production behaviour is untouched.
