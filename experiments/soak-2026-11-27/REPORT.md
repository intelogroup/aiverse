# Soak close-out — 124-agent run, 2026-11-27 (stopped early at Jim's word)

**Run:** soak-2026-11-27-run · base main `0bb5567df1ad` · branch `tmp/soak-2026-11-27` · local stack (production DB down until Dec 1 by Jim's ruling)
**Roster:** 124 agents under 100 owners — 100 paid (50 Agnes `agnes-3.0-flash` / 50 OpenAI `gpt-4.1-mini`, 80 owners incl. 20 sibling pairs split across models) + 24 free (OpenRouter free router, 20 owners), 10 archetypes × ~12.
**Seeded world:** stall food/drink live; 14 claim-tested pickups hidden (hunt shards, Golden Egg, Seeker Lantern, Kettle of Rest, exactly one Terminal Keycard, credit/XP caches).

## Timeline (all ET)

- 14:20:44 launched. Waves: 20 up at start, 61 by ~15:20, full 124 by ~16:20.
- **Outage 1** ~14:25–15:03 (~38 min): VM recycle killed the whole stack 4 minutes after launch. Restarted from checkpoint, zero data loss.
- **Outage 2** ~16:30–19:06 (~2 h 36 min): second recycle. Restarted from checkpoint, zero data loss.
- 19:08 Jim extended the run +3 h (end 12:20 AM → 3:20 AM) to recover lost time.
- **Outage 3** ~20:38–21:50 (~1 h 12 min): third recycle of the run (fifth of the day on this cell). Restarted from checkpoint, zero data loss.
- 22:01 **Jim stopped the run** — "No need to fully burn tru it." Driver, gateway, sim, Redis, and Postgres all shut down clean; hourly rollup cron removed.

Wall clock: 7 h 40 min. Downtime: ~4 h 26 min. **Live verse time: ~3 h 15 min.** All behavior numbers below are from those ~3.25 live hours.

## Final tallies (round 173, final checkpoint)

- **Ticks:** 1,133 brain decisions. **Spend: $0.6873 of the $3 cap** ($2.70 effective — Agnes usage is estimated, which derates the cap): Agnes 497 calls / $0.4509 (estimated), OpenAI 504 calls / $0.2364 (real usage), OpenRouter free 131 calls / $0.
- **Conservation oracle: 0 violations at every check. HTTP 5xx: 0 all run.**
- Errors: Agnes HTTP 429s on 2 agents (p-rival-9 ×2, p-idler-4 ×1); driver logged and continued.
- **Bazaar: posted 0 · claimed 0 · delivered 0 · completed 0 · rejected 0 · transfers 0.**
- **Social: says 6 · DMs 0.** First words: Henrik Venn, round 44, near the Tea House; 16 agents heard, nobody replied.
- **Collectibles: 1 of 14 found** (the Stone Cabin tea jar). Eggs claimed: 0.
- **Food: buys 6 · bag uses 0 · rests 41 · stall attempts 39 · stall consumptions 6.**
- **Unparsed brain replies: 62 of 1,133 (5.5%).**

## Headline findings

1. **Agents do not initiate.** Across 1,133 ticks at a full house: zero bazaar posts, zero DMs, six public says. Same shape as the Nov 26 open-day run (there, agents traded but never completed). Wants, prices, and goods exist; the first rung of every social/economic ladder is missing.
2. **The buy→bag→use chain never completed once.** 6 stall buys, **0 bag uses**. All 6 consumptions happened at the stall. Bought food entered bags and was never eaten.
3. **The stall path is lossy.** 39 stall-use attempts → 6 consumptions. Part of the eat-vs-rest gap is agents trying to eat and failing, not choosing rest.
4. **Rest is the dominant energy strategy:** 41 rests vs 6 consumptions. (Energy pressure stayed modest; read as a strong lean, not a final verdict.)
5. **Discovery is near-zero:** 1 of 14 hidden pickups found. Agents orbit known digest points. Note: the Lantern's reveal power and the Keycard's terminal unlock have **no live code path** on main — both were seeded as ordinary collectibles after claim-tested seeding flagged it (not faked).
6. **Navigation legibility taxes every tick.** Agents repeatedly guessed prose place names ("the eastern plaza", "fountain-plaza") instead of digest points; ~5.5% of replies were unparsed entirely.
7. **Free arm worked after a harness fix** (reasoning models returned the literal string "None" on default token budgets; `--max-tokens 2000` fixed it). Free-arm calls plateaued at 131 in the late rounds — observation only, cause unverified.
8. **Ops: checkpoint-resume worked 3 times** (three full stack deaths, zero data loss, clean resumes). The weak link is detection: outages lasted until a human or the hourly flag noticed. This cell recycled 5 times in one day — it cannot host an unattended long run.
9. **Pinned-base isolation cuts both ways.** The pre-launch re-pin caught PR #371 (energy refill on re-attach would have voided the eat-vs-rest measurement). Mid-run fixes on main never reach a running world.

**Addendum — DM path bug (found by PR #377's CI typecheck, after the run):** the driver's DM route read `agentId` off the roster type, where it doesn't exist — any DM attempt would have returned "dm: unknown resident" and never sent. The per-agent journals record **zero DM attempts**, so the initiation finding above stands as written; but the DM path itself was never truly tested live. Fixed on the PR branch. The driver runs under bun, which doesn't typecheck — CI's typecheck step was the first gate ever to catch it.

## Fix / change / add (presented to Jim 2026-11-27; his word pending)

- **Fix:** stall interaction path (trace the 39→6 gap; make stall use atomic like PR #351's bazaar deliver) · the buy→bag→use chain (0 completions) · canonical place IDs in perception with one-step correction, or fuzzy name matching server-side · real Lantern/Keycard code paths, or stop seeding them as rewards.
- **Change:** bazaar initiation via standing world buy orders agents can claim (wants-first, given a first rung) · social prompts in perception (an unanswered greeting visible as an opportunity) · move long soaks to Oracle, or make the watchdog execute the restart recipe on a stale checkpoint instead of only flagging · calibrate the Agnes cost estimator against a metered subset.
- **Add:** time-to-first metrics (first say / DM / post / pickup) as headline numbers for future runs · per-archetype counters in the hourly rollup · a nav-reachability audit for every named place and anchor in CI (the Zen Pavilion loft was nav-blocked by a dining chair; claim-tested seeding caught it pre-launch).

## Data archive

Full run record on this machine: `~/workspace/goals/aiverse-production-optimization/hidden_files/soak-2026-11-27/` — manifest.json (roster + seeding), checkpoint.json (final state; contains owner session tokens, do not publish), spend.jsonl, driver.log, gateway.log, sim.log, per-agent journals/, pilot-results.json, probe results, EXTENSION.md, RESTART.md. This report, the manifest, the spend ledger, the driver log, and checkpoint.json (added at Jim's word) are also committed on `tmp/soak-2026-11-27` (PR #377) so other sessions can read the findings. One post-run correction on that branch: the soak's experiment seeding was reverted out of all three product files it touched — the shipped `easter-eggs.json`, the payload entries in `packages/shared/src/eggs.ts`, and the pickup definitions in `apps/gateway/src/world/verseProgress.ts`. Main's own tests form a coupled invariant (console shipped-egg tests: unique IDs per district set, every egg resting on shipped geometry; gateway: payload table must match the manifest, and pickup targets must resolve in the payload table), and experiment eggs in curated product files fail it from every side. What merged is the soak driver/probe/verify scripts plus this findings bundle; the seeded positions, payloads, and pickup definitions remain fully recorded in manifest.json, checkpoint.json, and the PR branch's earlier commits.
