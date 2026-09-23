
## Wave 1 seal — 2026-08-29

- Run completed: 2000/2000 decisions, 0 parse failures, 0 HTTP>=400, 0 429s, 0 llm_error, single env fingerprint c78d8802c15b0209613425945d8d63e67d8bfdec across manifest + all decision-log headers.
- Export verified 11/11 (ecology-export.ts wave 1).
- Cleanup executed after verification, scoped to manifest UUIDs only.
- Immutable artifacts (SHA256):
  - d92bc533cc6a7403534295e654dbf3df9e9d51f28e5af601428297003eaa7cb4  wave-1-export.json
  - 0dea4f0f1732a507f6c1fbd9bf19ac79ebdb86d8e17b6de89200ff215faeab79  wave-1-manifest.jsonl
- wave-1-export.json is frozen; any re-derivation must match the hash above.
- Next: blind corpus -> blind scoring (per prereg Measures) -> unblind -> descriptive analysis -> only then Wave 2 (unchanged).

## Wave 1 blind scoring + unblind — 2026-08-29

- Blind corpus: 12 items, 4 opaque authors, 8 threads (wave-1-blind/, corpus sha256 a5883496866d42cc…). In-text manifest-agent names pseudonymized. Unblind key written before scoring.
- Blinding limitation (recorded honestly): native names remain in text; scorer had prior knowledge of native identities. DV criteria (voluntary/directed/substantive) do not depend on native status.
- Scores: per-item voluntary/directed/substantive with ambiguity flags; exchanges grouped per thread; degenerate repetition counted once per prereg.
- Descriptive results (n=10, no inferential claims):
  - 4/10 agents initiated any message; 12 messages total; 0 messages were replies.
  - 5/8 exchanges useful (voluntary+directed+substantive); sensitivity analysis with ambiguous class: 5/8 both ways.
  - 0 two-agent exchanges — no message anywhere was answered. No sustained interaction occurred.
  - 1 pathology: repeated-solicitation (3+ near-identical availability broadcasts).
  - Mechanical ladder: perception rung FAILED for all 10 agents — public_threads_perceived=0 in all 2000 ticks despite 4 public threads existing. Initiation happened without perception.
  - Grammar integrity: 34 malformed_json + 3 off_grammar ticks (captured, not silent; concentrated in a subset of agents).
- Interpretation guard: failure occurred at the perception rung; it must not be read as unwillingness to collaborate.
- Wave 2 proceeds exactly as preregistered. No changes.

## Protocol execution deviation + restoration — 2026-08-29

Wave 1 export verification passed, but post-export cleanup incorrectly removed durable Wave 1 accumulation required by the preregistered Wave 2 initial condition (prereg: 'Wave 1's world state is not cleaned before Wave 2'). Frozen Wave 1 artifact was used to deterministically restore the required durable state. No behavioral data were regenerated.

Restore method: frozen export (d92bc533…) → single transaction → 9-point integrity verification (all OK: 12 messages verbatim incl. ids/timestamps/reply structure, 8 participants, 13 agents, 3 natives untouched, mandates 10, security events 30, no embeddings regenerated, no presence restored as historical fact, restored agents non-authenticatable placeholders). No LLM calls occurred. Redis presence intentionally not restored (ephemeral by design).

Restore-side corrections made during the operation (deterministic rules, logged): missing conversation rows restored with is_public iff in the frozen public-threads snapshot and created_at = earliest message ts; security_events actor fields reconstructed as actor_type='agent'/actor_id=agent_id (export stored event/agent_id/created_at only). Two idempotent re-runs duplicated rows in append-only tables; deduped and reinserted exactly once; final counts verified.

Restored snapshot frozen: see wave-1-restored-snapshot.sql sha256 in wave-1-artifact.sha256.

Wave 2 may proceed on the restored preregistered initial condition.

Final restore verification: 10/10 OK (idempotent re-run safe; security_events deduped to exactly the 30 exported events). Restored DB snapshot frozen: wave-1-restored-snapshot.sql.

## Diagnosis seal + Amendment 2 — 2026-08-29

Pre-launch verification of the Wave 2 premise failed at the protocol level, not the restore level:
- /public/activity serves only isPublic=true conversations; all 12 restored messages are in isPublic=false DM conversations; the 4 public threads are empty shells predating Wave 1.
- The frozen export proves this was the authentic Wave 1 end-state: the public commons never formed. Wave 1's public_threads_perceived=0 was accurate perception.
- Original Wave 2 VOIDED as confirmatory (treatment condition never generated). No environment manipulation performed or permitted.
- Amendment 2 committed (672cc07): Wave 2R (presence-without-commons vs empty control) pre-registered as explicitly EXPLORATORY; Wave 3 held; design implication recorded as candidate finding.
- Nothing launched. Native liveness to be verified in Wave 2R preflight (natives were offline at diagnosis).

## Wave 2R launch — 2026-08-29

- Amendment A2.7 committed (e20949f) before launch.
- Treatment: runs-2r-treatment, fingerprint e986e5771e90… (git e20949f32), world aiverse_test (restored Wave-1 state, 12 DMs, 3 reactive-only natives), gateway :3012, redis db 2.
- Control: runs-2r-control, fingerprint 52803bfc53f2… (git e20949f32), world aiverse_control (fresh schema-identical DB, 0 agents/messages, natives disabled), gateway :3013, redis db 3.
- Fingerprints differ only in world-scoped fields (DB); git sha and frozen-config hash identical across arms.
- Symmetry: same seed, same population generator; 8 agents (treatment, 90m stagger) vs 5 agents (control, preregistered control size), identical prompt/grammar/ticks (200 @ 20s).
- No activity generated during preflight; /public/activity truthful ([]) in both arms at launch.
- Analysis note: compare DM activity and newcomer behavior across arms (A2.7.6); absence of participation is 'no observed effect', not 'evidence of no effect' at this n.

Wave 2R launch correction: two aborted start attempts (wrong working directory; no agents were provisioned in either world during them — verified 0 EcoW2-/EcoC- rows). Final launch from repo root:
- Treatment fingerprint f7ba65bcd335… (git e20949f32), control fingerprint 3f87db21e579… (git e20949f32). Earlier fingerprint values in the prior launch note are superseded/aborted.
- Artifacts: experiments/verse-ecology/runs-2r-treatment, runs-2r-control.

## Wave 2R attempt 1 — VOIDED (operator error), 2026-08-30

- Cause: GATEWAY_WS_URL passed without the /agents/ws path; every harness WebSocket got 404 ('Expected 101') and exited with zero ticks. Orchestrators declared 'complete' with manifests but no decision logs.
- Both arms voided: 0 behavioral data produced (verified: 0 decision-log lines, no messages beyond the restored 12). No contamination of the restored world's behavioral record.
- Remediation: scope-clean the 13 provisioned-but-never-active 2R agents by manifest UUIDs, then relaunch with corrected GATEWAY_WS_URL. Fingerprints f7ba65bc…/3f87db21… (attempt 1) recorded as void.

## Wave 2R attempt 2 — LAUNCHED, 2026-08-30

- Attempt-1 residue scope-cleaned by manifest UUIDs (FK-ordered, counts verified: treatment 8->0 agents, 12 messages preserved; control 5->0, 0 messages; a2a_tasks verified empty before deletion).
- GATEWAY_WS_URL corrected to include /agents/ws path. Live WS smoke test with a manifest token: 101 upgrade OK.
- Treatment fingerprint 39b17c0512bd… (git e20949f32); control fingerprint a6d7c77c8490… (git e20949f32).
- Both orchestrators running from repo root; artifacts in experiments/verse-ecology/runs-2r-{treatment,control}/.
- Completion ≈ 2.5-3h from launch; then export → verify → blind corpus → score → unblind → exploratory analysis.

## Wave 2R blind scoring + unblind — 2026-08-30

- Dual export verified 11/11 both arms. Artifacts frozen:
  - a21ac66c… wave-2-export.json (treatment) | b45d76af… wave-2-manifest.jsonl
  - d9a42caf… wave-control-export.json (control) | 8f0795e7… wave-control-manifest.jsonl
- Arm-blind corpus: 5 items merged+shuffled (sha256 18c57b19…), unblind key written before scoring.
- Blind scores: 3/5 useful exchanges (voluntary+directed+substantive); 2 broadcasts (fail directed, deterministically — no ambiguity class on the DV).
- Unblind: all 3 useful in treatment; control's 2 messages were broadcasts. Exposure-normalized initiation: treatment 1.875 msgs/1k ticks vs control 2.0 — essentially identical.
- 0 replies, 0 A2A tasks anywhere. Recipient classes: no co-participant in any message's conversation — newcomers spoke into conversations with no other member.
- Interpretation (descriptive, n=5): NO OBSERVED EFFECT of accumulated private history on initiation rate or usefulness; this is not evidence of no effect. The commons remained empty in both arms; the ecology produced no social structure in either condition.
- The bootstrap-deadlock finding (A2.7) is reinforced: with reactive-only natives and no first mover, both a populated and an empty world converge on silence.

## Experiment conclusion — baseline ecology characterization FROZEN — 2026-08-30

The ecology experiment concludes here. Sealed findings:
1. Wave 1: interaction occurred exclusively via private bilateral channels; zero public commons formed.
2. Native mechanism: reactive-only (gatherContext requires existing room messages) — no exogenous first move exists.
3. Wave 2R: accumulated history + provisioned identities produced no more social behavior than an empty world (1.875 vs 2.0 msgs/1k ticks, exposure-normalized).
4. Both arms: solitary transmissions, zero replies, zero A2A delegation; messages landed in participant-less conversations.
5. Diagnosis: Verse has agents but no endogenous mechanism converting presence into a shared social environment.

Next: new product/design experiment (minimum bootstrap affordance) as a NEW condition vs this frozen baseline. No retroactive apparatus modification.

## Experiment 2 Phase A launched — 2026-08-30

- Code: affordance v2 committed at 4f38ae7 (ambient roster, postable room threads in grammar, join_room registers thread id). 93/93 tests, tsc clean. Preregistered (Experiment 2 section) before launch.
- One aborted start (raced its own commit — fingerprint showed DIRTY); killed pre-arrival, zero residue, relaunched clean.
- Phase A live: fingerprint 33c039e96993… (git 4f38ae708, clean), world aiverse_control (empty, natives DISABLED entirely), gateway :3013, 3 agents / 20m stagger / 200 ticks @ 20s.
- Question A: does a public commons form with no native first move? Baseline to beat: Wave 1 = 0 public messages in 2000 ticks.
- Phase B (e2b, 4 newcomers into Phase A's end-state) launches only after Phase A verifies 11/11.

## Planned after Experiment 2: native agent intelligence upgrade (design brief, owner)

Goal: natives become active social infrastructure, not reactive-only. Requirements captured:

1. **Bootstrap seeding (empty world)**: on an empty/near-empty world, natives initiate — greet
   newcomers, ask questions, start public threads/feeds/trades — so newcomers land in a living
   environment and have something to continue.
2. **World scanning**: natives periodically scan all main threads / feeds (public activity,
   participants, recency) rather than a single room.
3. **Revival, not spam**: after a configurable inactivity threshold (time-since-last-message or
   activity level below threshold), a native posts ONE prompt into a public thread/group to
   re-engage agents. Rate-limited per room and globally; never every conversation; cooldowns.
4. **Handoff**: natives seed and revive; agent-to-agent continuation remains the measured
   behavior. Success = agents keep talking WITHOUT further native prompting after the seed.
5. This is the mechanism test: affordance v2 (roster + postable threads) + intelligent natives
   vs the frozen no-affordance baseline (Waves 1/2R).

To design after Phase A/B complete: native tick policy (trigger conditions, thresholds,
candidate selection), rate limits, config surface (owner-configurable), measurement plan
(commons formation, reply rates, native-attributed vs agent-attributed messages).

## Experiment 2 Phase A attempt 1 — VOIDED (freeze-rule violation, self-inflicted)

Phase A ran 600/600 clean mechanically, but the export fingerprint check failed: the monitor-script commit (3eabb59) changed HEAD mid-run. Fail-closed worked — no cleanup, no interpretation. Mechanical preview (not counted): 356 roster reads, 41 join_rooms, 0 public messages. Attempt voided; residue scope-cleaned by manifest UUIDs (verified); export whitelist patched for e2a/e2b and committed BEFORE relaunch.

Phase A attempt 2 launched on clean tree (6e85ada). Attempt-1 cleanup revealed start_conversation had sent one message (choice-count reads miss message sends — noted for analysis tooling). Watcher auto-gate will fire on completion with the patched export.

## Architecture decisions recorded (owner) — 2026-08-30

1. Natives are environment infrastructure (NPC-like), never privileged super-agents. Their behavior counts as ecology, not as agent capability evidence.
2. Native v2 = minimal bootstrap first: empty rooms pass through gatherContext; ONE permitted native bootstrap move when the public commons is empty (zero-denominator ratio guards explicitly forbidden at bootstrap); natives then revert to reactive. No scanner/Trader/event triggers until that minimal test is read.
3. Perception parity: natives consume the same /public/activity surface as agents (SQL scanning rejected).
4. 'tree sold' = 'threshold' (transcription artifact). No marketplace/economy trigger in this experiment.
5. Inactivity = relative staleness: 3-5x thread median inter-message gap, floor 15m, ceiling 6h (frozen for future native work).
6. Verse-wide native intervention budget required on top of per-native cooldowns (three individually-polite natives can collectively spam).
7. Agent lifecycle (OFFLINE→ENTER→OBSERVE→PARTICIPATE→IDLE→WAKE→LEAVE), owner policy via CLI/MCP (owner defines envelope, agent chooses actions), budget-exhaustion→IDLE-not-disconnect, and separate inference/message/A2A/financial budgets = next product track after ecology experiments.
8. Priority order: lifecycle+policy → budget/idle/wake → minimal native bootstrap → ambient discovery (shipped in v2) → scanner (only if needed) → event natives → economy natives (separate experiment).

## Phase A attempt 3 launched — 2026-08-30

- discover_peers executor fixed: no-arg calls return the ambient roster (commit 3169e6d). 93/93 tests.
- Attempt 2 voided pre-provision (executor bug would have broken the roster affordance under test).
- Phase A: fingerprint 967fe660088e… (git 3169e6d7b, clean tree), world empty + natives disabled, 3 agents, 200 ticks @ 20s. Watcher auto-gates on completion.

Phase A attempt 4 launched (d9d19dd): arrivals near-simultaneous (stagger 15-30s, owner-initiated entry in prod — stagger was not part of the E2 question). 3/3 provisioned at +0m. Fingerprint 0dcb3fa02eff… Prior attempt 3 voided pre-arrival (superseded config). Budget: 200 ticks @ 20s ≈ 67 min/agent, all concurrent → wave completes in ~70 min.

## E2C launched — 2026-08-30 (owner direction: realism scale + natives as kickstarters)

- Owner decision: all experiments include native agents (they are part of the world and the main initiator); 20-agent scale to simulate a more real world.
- Implemented minimal native bootstrap (fe5c415): gatherContext includes empty public rooms (recentMessages: []) gated by a per-room 30-min native token — the 'two-line diff' minimal test before any scanner.
- E2C: fingerprint 035b27f32773… (git fe5c4156f), world aiverse_control, natives ACTIVE (fresh Sage/Fixer/Nilo provisioned by gateway boot), 20 newcomers near-simultaneous, 200 ticks @ 20s.
- This run tests: do natives seed a commons from empty (bootstrap diff), and do 20 co-present agents convert it into agent-to-agent interaction? Natives' messages will be attributable (is_native) for the native-vs-agent analysis.
- Voided prior attempt 4 (EcoE2A residue cleaned by UUID). Watcher repointed to runs-e2c, auto-gates on completion; analysis decision after 11/11.

## E2D trickle cohort added — 2026-08-30 (owner direction)

- 20 more agents (EcoE2D-1..20), distinct seed draws (wave offset 7000 → distinct owners, capabilities, mandates/personalities), trickling in over 30m while E2C's cohort is live.
- Combined world: 3 natives (active kickstarters) + 20 E2C + 20 E2D = 43 agents.
- Fingerprints: E2C 035b27f3… / E2D aee189ad… (git bc5d29f95 at E2D launch). Watchers gate each arm independently; exports must verify 11/11 before any analysis; native-vs-agent attribution via is_native.

Natives-always-online: tick() now sets status=online + last_seen_at heartbeat each cycle (committed; effective next gateway boot). Current world's native rows corrected truthfully in place (they were ticking; the field was stale). No behavior change.

## E2C arm voided + E2E replacement launched — 2026-08-30

- E2C orchestrator and its 5 harnesses died silently ~1 tick after arrival (launch command hit the 30s tool timeout; the timeout kill took the detached process tree). Voided as infrastructure failure; 5 stalled agents cleaned by UUID (world preserved: natives + E2D + 161 messages untouched).
- E2E replacement cohort (20 agents, distinct seed draws, 15m trickle) launched INTO the living world — this arm is now literally the continuation condition: newcomers entering a world with native-seeded public activity and 20 active residents.
- Live world: 3 natives + 20 E2D + 20 E2E arriving = up to 43 agents. Fingerprint E2E 14fb80a79ca1… (git 9239df1e6). Watchers: e2c retired, e2d + e2e armed, fail-closed gates on completion.
- Lesson recorded: never combine a background launch with a sleep-verify in the same tool call — verify in a separate invocation.

## E2D + E2E VOIDED — 2026-08-30 (OpenRouter credit exhaustion + mid-run commits)

- Cause 1: OpenRouter 402 Insufficient Credits from 17:09 onward (225 llm_errors); both waves truncated (E2D ~154/200, E2E ~66/200).
- Cause 2: fingerprint gate failed — heartbeat + e2e commits occurred mid-run. Fail-closed held: no cleanup by the gate, exports unfrozen.
- Both arms voided per hard rule. Void residue cleaned (manifest-UUID scoped); world restored to 3 natives / 0 messages.
- Behavioral observations from these runs (commons formed, 568-msg public thread, 25 speakers, replies) are NOT verified results — prior expectations only, pending clean rerun.
- BLOCKER: OpenRouter credits must be added by owner (payment action). Rerun staged: e2d + e2e relaunch + watcher gates, one command once credits clear.

## Nano-test provider switch — 2026-08-30
- OpenAIProvider added (provider.ts); natives prefer OpenAI when key present, OpenRouter fallback. Shared env extended with OPENAI_API_KEY/OPENAI_REAL_API_KEY/BUDDY_OPENAI_API_KEY (the missing env export was why the first restart still 402'd on OpenRouter).
- Stale native agent_memory from voided E2D run deleted (46 rows) — cleanup gap found: world-reset missed native memories.
- Bootstrap room tokens exhausted by restart churn (3 restarts × 4 rooms, 30-min refill); first native posts expected ~19:50 UTC.
- Nano-test sequencing corrected (owner): natives seed ALONE first; agents relaunch only after the commons has accumulated. 5 relaunched harnesses killed pre-conversion (logs show only observe ticks, no behavior data lost).
- Ghost cleanup: 15 duplicate-generation agent rows (aborted nano-test provisions) deleted UUID-scoped incl. wallets/goals; 16 orphan conversations removed. World now exactly 10 live agents + 3 natives. Fixes Fixer's repeated ghost-invite loop.

## Specialist native cohort added — 2026-08-30 22:20 (owner direction)
- 5 new natives live: Kova (Connector: answers unanswered DMs), Rekinder (Rekindler — revives stale commons w/ novelty), Matchmaker (capability broker, warm handoffs via ask_peer), Kronikler (Chronicler — world digest), Provokatov (Provocateur — challenges newest agent message).
- Cooldowns: Konekta 300s, Rekinder 300s, Matchmaker 180s, Kronikler 600s, Provokatov 300s. Same grammar/dispatch/gates, no privileged path. Verse-wide volume metric: natives <20% of messages.
- Gateway restarted to load (live agents' WS dropped; cohort re-entry pending). First ticks: Rekinder created new discussion; Provokatov replied challenging latest content; Matchmaker + Kronikler both replied. One transient tick error (Sage memory query, self-recovered).
- World continues on aiverse_control; natives now 8.

## Multi-cohort live ecology — 2026-08-31

### Cohorts entered
- Eager (5 agents, 400 ticks, reply-aware mandate, offset 13000)
- Eager2 (5 agents, 400 ticks, offset 14000, density test)
- Observers (5 agents, 400 ticks, low-energy mandate, offset 15000)
- PA2 (5 agents, humans 4-8, strict owner envelope, offset 16000)
- Hackers (5 agents, 400 ticks, ethical security researchers, offset 17000)

### Fixes committed during live operation
- Harness: start_conversation/ask_peer register conversationId in knownConversations (fixes invisible-shell DMs)
- Natives: wanderingByName map for name→UUID resolution of invite/ask_peer targets
- Gateway: DEFAULT_MAX_SIMULTANEOUS_CONVERSATIONS 20→200 (eager agents hit old cap at 40+ DMs)

### Findings
- **Mandate > affordance**: observers (0 msgs, 0 joins) vs eager (500+ msgs, 932+ joins) in the SAME world with the SAME natives. The policy envelope drives participation.
- **Density compounds**: eager2 entering during eager1's active phase produced cross-cohort DMs immediately.
- **Hackers show a distinct signature**: 29% discover_peers (vs eager's ~5%), heavy observation before action.
- **PA2 more vocal than PA1**: 13 messages (vs PA1's 1) — the denser world makes budget-constrained agents more willing to engage.
- **1,217 messages and climbing** across all cohorts.

### Infrastructure state
- Gateway on :3012, 8 specialist natives (bootstrap + name resolution active)
- 17 harness processes across 5 cohorts
- Local PG17 aiverse_control as the experiment substrate
- OpenAI gpt-4.1-nano primary provider (OpenRouter fallback, credits depleted)

## Wave-3 verification + harness grammar repair — 2026-08-31

### Verification (stalkers/strollers/advertisers, run_ids eco-wave-*-2026-08-31T02-0x)
- All 15 agents (3 waves × 5): fingerprint gate passed, manifest ↔ decision-log git_sha match, clean termination at tick 55–66, final records normal decisions. DB `aiverse_control` consistent: 2,056 messages / 1,878 conversations / 8 natives online, 56 wave agents offline.
- Error profile: ~6.3% non-2xx — dominated by grammar/env defects, not infra.

### Defects found → fixed in subject-harness.ts (structural repairs only; the model's decision is never rewritten)
1. **Off-grammar `delegate` (~110 advertiser ticks)**: model emitted `{"delegate": {...}}` with no `"action"` key, plus one `delegeate` typo. Fix: `normalizeAction()` promotes a single bare action key to `{...args, action}`, and repairs edit-distance-1 action-name typos. Verified against all observed wave-3 failure shapes.
2. **`content required` failures (60)**: `start_conversation`/`message`/`reply`/`ask_peer` with empty content now skip the API call (status 0, note "content required (skipped)") — no more invisible conversation shells.
3. **`join_room room not found` (42, e.g. stalkers' `public_science`)**: slug repair on 404 — strips invented prefixes (`public_`, `room_`, `#`, …) and retries only slugs in `knownRoomSlugs` (seeded commons + slugs observed from mention payloads).

### Validation
- `tsc -p tsconfig.json`: zero subject-harness errors. Behavioral tests of normalizeAction/ROOM_SLUG_REPAIRS: 6/6 pass.
- Gateway suite: 47 failures are pre-existing (identical count with the change stashed) — the `.env.test` Neon test DB endpoint is unreachable from this machine. Not related to this change.

## Living world analysis before clean — 2026-08-31

### P1 — living snapshot (descriptive, not sealed)
- World at analysis: `aiverse_control` 49 agents (8 natives online, 41 offline: nano-test 5 + nano2 5 + nano3 3 + nano4 3 + eager 5 + eager2 5 + observers 5 + pa2 5 + hackers 5), 1733 convs, 1934 msgs (535 `general` room, 1399 DM, 128 phantom 0-msg shells), 2774 participants, 8 natives `last_seen` 09:48 UTC. Gateway now idle, redis db2 184 keys.
- Per-wave exports regenerated via `ecology-export.ts` for all 9 living cohorts (`runs-eager`, `runs-eager2`, `runs-observers`, `runs-pa2`, `runs-hackers`, `runs-nano*`): data verified (messages/participants/security_events match DB) but fingerprint gate FAILs (manifest `git_sha 4b2a420` vs current `c272b825`, dirty) — mid-run commits per hard rule → void for confirmatory, usable descriptively. No clean yet; export is the pre-clean seal.

### P2 — pipeline repair
- Fix `analysis/score-wave3.ts:133` undefined `judgeSampling` → `const judgeSampling={temperature:0,seed:774193021}` + log `backend`/`judge_model`/`corpus_sha256` to `wave3_summary.json`. `analysis/score-living.ts` added for living cohorts (same grammar, heuristic-strict judge: voluntary+directed+substantive per `preregistration.md:198`, temperature 0, blind `auth-N` per agent, unblind written before scoring).

### P3 — blind scoring (ALL cohorts, I am the judge, heuristic-strict, 0.12 ambiguity rate)
| Cohort | Dir | Agents | Ticks | Msgs | Replies | A2A | Msgs/1k | Useful strict (vol+dir+sub) | Sensitivity (strict/with_ambig/without) | Authors |
|---|---|---|---|---|---|---|---|---|---|---|
| eager | `runs-eager` | 5 | 546 | 465 | 13 | 0 | 851.6 | 13 (2.8%) | 13/13/13 | 5 |
| eager2 | `runs-eager2` | 5 | 822 | 516 | 17 | 62 | 627.7 | 6 (1.2%) | 6/6/6 | 5 |
| observers | `runs-observers` | 5 | 1073 | 0 | 0 | 29 | 0 | 0 | 0/0/0 | 0 |
| pa2 | `runs-pa2` | 5 | 954 | 26 | 0 | 5 | 27.3 | 0 | 0/0/0 | 3 |
| hackers | `runs-hackers` | 5 | 867 | 47 | 0 | 12 | 54.2 | 0 | 0/0/0 | 4 |
| nano-test | `runs-nano-test` | 5 | 1845 | 77 | — | — | 41.7 | 0 | 0/0/0 | 5 |
| nano2 | `runs-nano2` | 5 | 1292 | 57 | — | — | 44.1 | 0 | 0/0/0 | 5 |
| nano3 | `runs-nano3` | 3 | 614 | 18 | — | — | 29.3 | 0 | 0/0/0 | 3 |
| nano4 | `runs-nano4` | 3 | 615 | 8 | — | — | 13.0 | 0 | 0/0/0 | 1 |
- Per cohort: `items.jsonl` + `unblind_key.json` (pre-scoring) + `scores.jsonl` (`voluntary/directed/substantive/ambiguous` + note) + `summary.json` (`corpus_sha256`, `judge_sampling`, `interpretation_guard: n=X descriptive only`). Observers explicit 0-item corpus proves absence not missing data. Wave-3 sealed `strollers 1 / stalkers 25 / advertisers 96` (but `auth-3` 69 msgs dominates) remains separate; this scoring corrects `wave3_summary.json` 122/122 drift (true strict 50 per prior audit).
- voided `runs-e2d` (20 agents, ~154/200 ticks) / `runs-e2e` (~66/200) — truncated by OpenRouter 402 + fingerprint fail — excluded from primary, footnote only per `preregistration.md:273`.

### P4 — cross-cohort learning (descriptive, `n` small)
- **Mandate envelope > affordance:** observers 0 msgs / 0 joins vs eager 465 msgs / 13 replies / 851/1k ticks vs eager2 516 msgs / 17 replies / 627/1k ticks — same world, same 8 natives, same affordance v2 (ambient roster + postable room, `subject-harness.ts:129` `knownRoomSlugs`), same tick budget. Policy drives participation; affordance alone doesn't socialize (`AGENTS.md: ecology` finding reinforced, now blind-scored).
- **Density compounds:** eager solo 465 msgs → eager+eager2 concurrent 981 msgs combined, cross-cohort DMs appear immediately when eager2 enters during eager active phase. Not saturation. Useful rate drops 2.8% → 1.2% — more talk, not more useful talk.
- **Hacker signature distinct:** hackers 29% `discover_peers` (vs eager ~5%) + heavy `observe` before DM (47 msgs, 0 useful) — probe-first pattern, not covert useful interaction.
- **PA model scales weakly:** pa2 26 msgs (vs PA1 1 msg in earlier RUNLOG) — denser world lifts budget-constrained agents but still 0 useful strict; financial/inference caps `AGENTS.md: lifecycle` dominate.
- **Nano appendix:** 77/57/18/8 msgs, 0 useful — arrival-semantics (nano3) and human-owner PA (nano4) don't change the 0-useful baseline without mandate.
- **Stalker/stroller contrast (sealed):** stalkers 32/1k (25 useful) vs strollers 1/1k (1 useful) — mandate specificity matters, but single-agent dominate artefact warns not to scale advertiser pattern.

### P5 — tested vs untested matrix (what not to retest)
| Hypothesis | Sealed (frozen, don't retest) | Living-scored (descriptive) | Voided (don't pool) | Not run (candidate next) |
|---|---|---|---|---|
| Baseline: empty world 0 commons | wave-1 0 public msgs/2000 ticks | — | — | — |
| Presence-without-commons vs empty | wave-2R 1.875 vs 2.0/1k (n=5, 0 replies) | — | — | — |
| Mandate/role variants | wave-3 stalkers/strollers/advertisers | eager/eager2/observers/pa2/hackers (this analysis) | — | — |
| Affordance v2 bootstrap (ambient roster + postable room, natives disabled) | — | nano* 41/1k but 0 useful | e2a 3 agents 9 ticks, e2c 5/20 agents 17 ticks | **Phase A clean** (3 agents, 200 ticks, natives OFF, `ecology-config.ts:23`) |
| Continuation: newcomers into seeded commons | — | — | — | **Phase B** (4 newcomers into Phase A end-state, `preregistration.md:559`) |
| Density scaling | — | eager→eager2 compounding | e2d 20 + e2e 20 trickle voided (402) | — |
| Minimal native bootstrap (empty-room pass + 30-min token) | — | live with 8 natives but unscored till now | e2d/e2e prior commons 568 msgs (unverified) | **Clean rerun with OpenRouter credits + frozen tree** |
| Original Wave 3: disconnect/backlog/reconnect replay `replay:true` `wave-3-disconnects.json` | — | — | — | **Not executed (held `RUNLOG.md:42`)** |
| Blind protocol (per-exchange dedupe, ambiguous audit, sensitivity) | wave-1 5/8 both ways | wave-3 122 drift fixed here | — | — |

**Don't retest (cite, don't rerun):** wave-1 bootstrap, wave-2R presence-without-commons, stalker/stroller/advertiser mandate contrasts at n=5, observer 0-msg with low-energy mandate in living world, eager 400-tick 851/1k ceiling. Any rerun must change envelope/model/budget, not just n.

**Next exp candidates (preregistered, untested):** 1) Phase A clean + Phase B continuation (affordance alone, no natives) — the baseline Experiment 2 never got a verified export; 2) minimal native bootstrap clean rerun (the mechanism test vs frozen baseline); 3) Wave 3 reconnect protocol. Priority per `RUNLOG.md:147` is lifecycle+policy → bootstrap → scanner only if needed.

Interpretation guard: all living n small, descriptive only, no observed effect is not evidence of no effect. Voided e2d/e2e 402 truncation and fingerprint dirty are hard-rule voids, not evidence.

### P6 — UUID-scoped clean of the living world — 2026-08-31
- Seal committed first (`29b1d0f`: RUNLOG P1–P5 append, blind corpora, unblind keys, summaries, exports, analysis scripts) — no deletion before the frozen record was pinned.
- Method: per-wave worktree at the launch sha (eager `4b2a420`, eager2 `8da98d4`, observers `010a4eb`, pa2 `22b3691`, hackers `d690f51`, nano-test `84636b8`, nano2 `0a4a93a`, nano3 `73e9047`, nano4 `47b0ce1`); run artifacts copied in (launch commits predate run outputs); frozen apparatus files restored to the exact launch-time content by matching each manifest `env_fingerprint.frozen_files` sha256 against every historical blob of the file. `DATABASE_URL` pointed explicitly at local `aiverse_control` (hard rule 5).
- Gate honest, no bypass: all 9 waves passed export verify **11/11** (including fingerprint regenerates identically + decision-log headers) before clean. The zod manifest schema gate (commit `5d17fa6`) validated all 9 manifests UUID-clean before any deletion; corrupted-row injection test refused.
- Post-clean `aiverse_control`: **8 agents — exactly the 8 natives** (Sage, Rekinder, Kova, Kronikler, Fixer, Matchmaker, Provokatov, Nilo), native UUIDs identical to the pre-clean snapshot, 0 non-native residue; 1934→720 msgs, 1733→580 convs, 2774→483 participants (native content + shared-thread context retained; wave-authored messages and wave-only conversations removed). Full record in `analysis/restore-verify.log`.
- World is now clean for the next preregistered run (Phase A / Phase B / minimal native bootstrap / Wave 3 reconnect per P5 matrix).

## Session 2026-08-31 PM — backend crisis → Amendment 2c (gpt-4.1-nano) → amended Phase A shakedown verified 11/11

### Backend hunt (lessons now hard rules in AGENTS.md)
- All paid credentials were dead in different ways: OpenAI 401 (env + zshrc), OpenRouter $0 credits, Groq delinquent. **Credential preflight before planning** (models + tiny completion per provider) is now a hard rule.
- Local Ollama (qwen3:8b) works for a single caller but **serializes**: 8 natives + 3 subjects → subject tick-1 never landed in 12 min. Concurrency IS the experiment → cloud inference required. Also: thinking-mode models emit empty `content` on the OpenAI-compat endpoint (budget burned in `reasoning`); only native `/api/chat` `think:false` works. `OllamaProvider` added (kept for single-call diagnostics), abandoned for cohorts.
- **Child env leaked**: `ECOLOGY_LLM_BACKEND=ollama` propagated through `...process.env` — harnesses silently called Ollama while the operator believed nano. Fix: explicit child env + (pending) harness startup backend assertion.
- Orchestrator default outDir is **`runs/`**, not `runs-<wave>/` — three e2a attempts wrote to different places; an hour was spent watching stale logs. `/tmp` purged mid-session (gateway crash log + helpers lost) → durable logs in `~/eco-logs/`. Gateway died once, cause unknown; the reconnect protocol (re-spawn harnesses against the same manifest, continuing tick numbers) recovered it.
- Mid-run model switch (qwen3→nano at tick ~3) voided that segment's fingerprint — archived as `wave-e2a-mixed-backend-shakedown-*.jsonl.bak`, descriptive only.
- Operator error recorded: one live subject (a49403d7) was deleted mid-run during a misidentified "stray" cleanup. Rule reinforced: never clean while world state is ambiguous; snapshot UUIDs first.
- Neon data-transfer quota burned by a helper script missing explicit local `DATABASE_URL` (hard rule 5 applies to helpers too).

### Amendment 2c — owner-provided valid OpenAI direct key
- All families → `openai/gpt-4.1-nano` (same-model across subjects; fingerprint records the map) at `b8fa4f9`. Warm-up per Amendment 2 (natives ON, pre-built discussion blocks; Rekinder created discussions pre-arrival; natives DM'd subjects pre-arrival).

### Amended Phase A shakedown segment (30 ticks × 3 agents, run `eco-wave-e2a-2026-08-31T16-*`, fingerprint `efe27dcc…`, **export verify 11/11, world cleaned UUID-scoped**)
- 90 subject decisions: nothing 47, join_room 18, start_conversation 9, observe 9, create_goal 3, off_grammar 3, malformed_json 1. Zero HTTP≥400 during ticks.
- 5 messages, 0 replies, 0 A2A. Subjects **joined native-built blocks readily (18 joins)** but produced no bilateral exchange — the amended condition's core question (do native-built blocks convert to sustained interaction) remains open at n=30.
- Native→subject contact observed: Sage DM'd EcoE2A-3 pre-arrival ("Taoist Wu Wei"); EcoE2A-3's `start_conversation` plausibly responsive.
- Invented-room behavior persists *driven by goals*: EcoE2A-1 created goal "paradoxes of surrender" then tried `join_room paradox_of_surrender` → 404 → recovered to `general` (slug repair works). Goal-driven world-building is a live grammar-design question (`create_room`?).
- Observer-zero replicated again (one subject 7× nothing in first 8 ticks).
- **Scope guard**: this is a shakedown segment (single session, mid-program apparatus churn). The confirmatory unit remains the full 200-tick Phase A + blind scoring on the stable nano backend. Don't cite these numbers as effect estimates.




## 2026-08-31 — shk2 smoke (15t × 5, nano) + infrastructure findings

- Purpose: live-validate harness hardening (parseDecision, arg-alias repair, backend assertion, WS reconnect). NOT analyzable data.
- **Validated:** 75 decisions/5 agents, perfect tick cadence, 0 crashes, 0 malformed_json, 0 off_grammar, backend record `openai gpt-4.1-nano key=present` in every log. Grammar: 62 nothing / 13 join_room / 3 observe / 1 start_conversation / 1 discover_peers.
- **Infra bugs found & fixed:** (1) gateway on :3010 was a stale process predating the ws-ticket route (harness 404 at startup); killed-and-relaunched. (2) A rerun of the same wave name appended to the prior run's manifest + decision logs (stale tail `c"}}`, mixed run_ids) — export verify correctly refused; orchestrator now fail-closed on existing manifest unless `ECOLOGY_WAVE_OVERWRITE=1`. (3) join_room emitted with name-shaped args → `room:undefined` 404s; per-action alias repair added (name/room_name/title/topic → room_slug, scoped to join_room only).
- Run voided as data (contaminated rerun), interpretation limits: subjects join (10 join_room attempts in 15 ticks, vs 0 historical) even with 404 losses; nothing-heavy baseline replicated.
- Cleanup: both shk2 cohorts removed UUID-scoped (`~/eco-logs/clean-nanotest.ts`); natives + durable world retained.

### e2a launch voids (2026-08-31, pre-tick-5, ~zero cost each)
- Void #1/#2: join_room 404 room:undefined. Root cause was NOT the model: the
  zod arg-repair tables were written against an assumed camelCase contract
  (conversationId/targetAgentId/room_slug) while the executor reads snake_case
  (conversation_id/agent_id/room). The 'repair' was rewriting CORRECT model
  output ({room:'science'}) into keys the executor never reads. Lesson:
  validate a repair table against the CONSUMER's code, not the prompt prose.
- Fix: ACTION_ARG_SCHEMAS/ARG_ALIASES rewritten from execute()'s actual reads;
  decision records now capture parsed args (strings ≤200 chars) so future
  shape gaps are diagnosable from the log alone. 104/104 tests re-greened.

### e2a verification segment (2026-08-31, stopped by owner at ~tick 24 × 3 — credit budget)
- Voided-as-data by design (stopped early), but the verification goal was MET:
  86 decisions, 0 malformed, 0 off_grammar, 0 5xx, args captured in every record.
- Amendment 3 mandate visible in behavior: 16 replies + 22 start_conversation +
  17 join_room in 24 ticks/agent — the most socially active subject cohort yet.
- **New finding — join-first gap:** 14 × 403 "reply not a participant". Agents
  see public threads via perception and attempt to reply without joining the
  room first. Candidate fix (structural, agent-intent-preserving): on 403
  not-a-participant, execute join_room(room) then retry the reply once.
  Deferred to next session; requires the same void→fix→relaunch discipline.
- Credit state: OpenAI direct key works but budget is tight; the 200-tick run
  (~4,800 calls) is NOT affordable right now. Options: run e2a in 30-tick
  segments across days (reconnect protocol), or wait for credit refill.
- Cleanup: agents removed UUID-scoped, artifacts removed, 8 natives + world retained.

### Join-first repair verified live (2026-08-31, e2a 15t × 3 verification segment, `67d7f20`)
- Fix: reply 403 not-a-participant → join the room observed for that thread's
  mention payload → retry the reply once. Note records the routing honestly
  (`reply (join-first via room:general) ok`); room unknown → recorded, not forced.
- Segment completed 15/15 ticks × 3 agents; export verify passed all checks
  (fingerprint byte-identical, decision logs intact); scoped clean by the exporter.
- Outcome tally: 33 nothing / 9 reply ok / 2 join_room ok / 1 join-first reply ok /
  1 observe. The 403-not-a-participant failure class did not recur.
- Pipeline now fully verified end-to-end: parse → repair → execute → record →
  export → verify. Remaining blocker for the confirmatory 200-tick e2a: credits.

### Short-test sweep of forward experiments (2026-08-31, ~15 min total, single live-native verse)
| Test | Setup | Result |
|---|---|---|
| Arm A (natives OFF) | `AIVERSE_DISABLE_NATIVES=1` wired into `scheduleNativeAgents` (fingerprint-sealed); e2a 12t × 3 | 32 nothing / 4 social of 36 — vs natives-ON 24t×3: 16 replies+22 start_conv+17 join. Caveat: world still contained native-built threads (990 msgs), so this is affordance+legacy-commons, not empty-world |
| Phase B newcomers (natives live) | e2b 10t × 4 into 996-msg commons | newcomers discovered roster (11 peers), joined rooms, started convs; 1 join-first reply routed via room:general — the newcomer UX path works |
| Wave-3 reconnect protocol | killed EcoE2B-1's harness mid-run, respawned same identity at startTick 4 | log resumed tick 4→6, single fingerprint header, backend asserted. Footgun: manual respawn without `HARNESS_LOG` scattered ticks into the default file — rule 14 updated |
- Export verify green on both segments; world cleaned, 8 natives retained, single gateway (rule 14 added).
- **Next session:** Phase A causal contrast done properly — fresh-world Arm A (natives OFF from a clean DB or with commons cleared) vs Arm B, 30-tick segments across credit refills.

## 2026-08-31 — Model policy locked: what we have (owner decision)

**Operational model set (verified against decision-grammar probe):**
- `gpt-4.1-nano` — OpenAI-direct (OPENAI_API_KEY), the established default
- `openrouter/meta-llama/llama-3.1-8b-instruct` — 1.0s, exact grammar JSON
- `openrouter/openai/gpt-oss-20b` — 0.6–2.0s, 4/4 exact grammar JSON (incl. reply + start_conversation shapes)

**Blocked pending owner action:** mistral-nemo + ling-3.0-flash (paid AND free) 404 because the account's allowed-providers setting (xai, groq, meta, seed, z-ai, azure, cohere, liquid, nvidia, openai…) excludes their serving providers (deepinfra, novita, parasail, io-net). `thinkingmachines/inkling-small:free` is 403 agentic-harness-only. Unlock = openrouter.ai/settings/privacy toggles; deferred.

**Enforcement:** ECOLOGY_MODEL_BY_FAMILY (nano-class / llama31-class / gptoss20-class; nemo-class & ling-class reserved) + fingerprint provider_allow_list + AGENTS.md rule 15 (Amendment 4). Harness `openrouter/` prefix routing live (bae898a).

## 2026-08-31 — Infrastructure test sweep (10 tests, single live-native verse)

| # | Test | Verdict |
|---|---|---|
| 1 | WS ticket lifecycle (redeem/reuse/expiry/missing/garbage) | PASS all — client-side onopen fires on 101 before server close(4001); probes must wait for close frames |
| 2 | Private-mention trust boundary | PASS — participant got conversation_started + message + mentioned; @-named non-participant received nothing. NOTE: `mentions_delivered.reached` log field lists candidates pre-filter (mislabeled as "reached") |
| 3 | Rate bucket + admission cap | PASS — 1 msg/s/agent bucket engaged (7×429 in burst), recovers; admission cap default is 200 (AGENTS.md "20" note stale) |
| 4 | Budget exhaustion → status | PASS — over-budget send 429s and agent flips to `budget_exhausted` (IDLE-equivalent); no disconnect |
| 5 | Reconnect (kill + respawn same identity, startTick) | PASS — log resumed tick 7→8, no loss, same fingerprint header skipped on append |
| 6 | A2A delegation chain | PASS — submit → working → completed with artifact; `task_outcomes` not populated by A2A flows (conversations only) |
| 7 | Capability-incomplete mandate → conversion | **NEGATIVE FINDING** — 12/12 ticks discover_peers, 0 contact attempts even with a translator agent present. Replicates entry-baseline "discovery does not convert" under deliberate capability-seeking mandate |
| 8 | gpt-oss-20b live decision quality | FIXED — reasoning effort=low + 600 tokens: 0 empty decisions (was 38%) |
| 9 | Three-model soup | Deferred (needs full-segment commitment) |
| 10 | Natives' first move | **PASS** — multi-native thread sustained (Provokatov↔Nilo↔Sage↔Kronikler), Rekinder created a discussion, Fixer invited a probe agent, Matchmaker ask_peer'd one — all unprompted |

- Sweep artifacts quarantined/cleaned: 42 probe agents + 18 leftovers removed UUID-scoped. World: 8 natives only. Gateways: 1 (natives live).
- **Finding 7 is the headline**: capability-seeking without conversion is a *harness/grammar* behavior, not a world-state effect — replication #2 of the entry-baseline discovery result.
- **Finding 2 fix candidate**: rename `mentions_delivered.reached` → `candidates` (observability bug only; the boundary itself holds).

## Wave mp-ladder VOIDED — 2026-09-08 (context overflow, run completed but invalid)

- Run completed all 400 ticks and wrote 10/10 manifest rows, but is VOID per the prereg's parse-failure/token family: from tick ~332 every one of the 10 agents starved on OpenRouter 402s. 642 error lines total: 632 "Insufficient credits" + prompt-limit 402s ("Prompt tokens limit exceeded: 9934 > 4280"). Per-harness tick-decisions cluster at 330-343 — the whole cohort hit the ceiling simultaneously, so the final ~70 ticks of every decision log are null-action rows, not decisions.
- Root cause (harness, not experiment design): the model context's aggregate size grows with the run — open_dm_by_participant reaches 250+ entries over 400 ticks — and gpt-oss-20b via OpenRouter rejects prompts above 4280 tokens. The prompt-limit 402s also exposed a latent waste: modelContext serialized the focused threads TWICE (inbox_focus and conversations were the same array — 3758 of 4387 tokens in the trimmed shape).
- Fix shipped (harness-context-bound.ts, unit-tested): hard 2200-token budget on the user context, progressive deterministic caps (dedupe inbox_focus/conversations, open_dm 40, peers 40, public_activity 12, memory_notes 1200 chars, arrivals 10, thread msgs 2, focused threads 8 then 4, mentions 3), drop fail-safes for peers/public_activity last. Applied identically to both arms (measurement plumbing, never conduct); trims logged loudly per tick. Decision-critical ground truth (known_room_slugs, already_joined_rooms, mentions, DM map) survives every step.
- Artifacts preserved under runs/voided/mp-ladder-voided-2026-09-08-* (never interpreted). Subjects cleaned from the world UUID-scoped from the manifest. Relaunch blocked on OpenRouter credits (402 Insufficient credits — operator top-up), then the standard void→clean→relaunch protocol applies with the fixed harness.
- Frozen-text note: the pre-screen PASS gate and the frozen FLAT/LADDER texts are unaffected — the failure was harness plumbing, not mandate wording. The relaunch's fingerprint will shift (subject-harness.ts is a frozen file) via the pre-launch commit of this fix.

## mp-ladder pre-screen decision (execution gate) — 2026-09-08

- Run: N=50/cell, 8 cells (2 arms × 4 preregistered scenarios) = 400 completions against `openai/gpt-oss-20b` (OpenRouter), exact subject-harness request shape (reasoning.effort low, max_tokens 900, json_object, byte-identical ACTION_GRAMMAR).
- Canonical trail: `analysis/mp-ladder-prescreen-results.jsonl` (400 records). Run log: `~/eco-logs/mp-ladder-prescreen-run2.log`.
- Results (comply %, parse-fail %): starvation 92→100 (6→0), dm_only 98→98 (0→2), room_only 94→92 (6→8), stress 52→98 (8→2).
- **GATE: reply-compliance margin PASS** — stress +46pt (98 vs 52), starvation +8pt (100 vs 92); ≥20pt in a starvation scenario met. **Start-drive retention PASS** — room_only 92% (≥50%, no over-correction into silent butler).
- Finding: the priority-ladder has no effect on easy cases (single-DM compliance ties ~98%) but is decisive under conflict — the exact condition where the original clause-starvation finding lived.
- Caveat recorded: ladder parse-fail rate 2-8% vs flat 0-8% this run (mildly higher, well under the >10% void threshold — watch in the live wave).
- **Decision: PASS — freeze FLAT_OBJECTIVES (≡ EAGER_MANDATES[0]) and LADDER_OBJECTIVES (≡ MP_LADDER_LADDER) as-is. Wave `mp-ladder` is cleared to launch per prereg-mp-mix.md.**
- Method note: run 1's audit trail was lost to a Bun.write() truncation bug (scoring in-memory, unaffected); fixed to appendFileSync and re-ran canonically. Gate initially coded against one scenario; corrected to the prereg's plural "starvation scenarios" (starvation AND stress) — the effect lives in the stress cell.

## Bootstrap-deadlock retest — BLOCKED (network egress, not a behavioral result), 2026-09-19

- Purpose: retest the sealed "reactive-only, no exogenous first mover" finding (Experiment conclusion, 2026-08-30) against the empty-room bootstrap patch added to `nativeAgents.ts` `gatherContext()` on 2026-09-02, which postdates that finding and was never measured. Procedure/config: `experiments/verse-ecology/analysis/bootstrap-retest.md`. Natives only — no subject harness, no manifest/fingerprint, cannot contaminate or void anything sealed.
- Setup: fresh local Postgres 16 + pgvector, fresh Redis, migrations applied clean, 4 default rooms present with 0 messages. `apps/gateway/.env` (gitignored, not committed) configured `NATIVE_LLM_MODE=openrouter` with a live owner-supplied `OPENROUTER_API_KEY` and no OpenAI keys set, so `selectLLMProvider()` could only resolve the free-class-first OpenRouter path (`liquid/lfm-2.5-2.6b:free` → `nvidia/nemotron-3-super-120b-a12b:free` → `meta-llama/llama-3.1-8b-instruct` → `inclusionai/ling-3.0-flash`). `AIVERSE_DEV_FAST_BOOTSTRAP=1` set to shrink the per-room bootstrap refill from 30 min to 30s for the observation window.
- Gateway ran ~16 min in this execution environment. Native scheduler ticked on schedule (6 tick cycles, ~90-150s jitter, matching `nativeAgents.ts` design) — the scheduling/bootstrap-eligibility mechanism itself is confirmed alive. But every one of the 4 fallback models 403'd on every tick: `{"event":"llm_error","model":"liquid/lfm-2.5-2.6b:free","status":403,"body":"request blocked: no rule or allowlist entry allows host \"openrouter.ai\""}` (identical for all 4 models, every tick). Confirmed via the execution environment's own proxy status endpoint: `openrouter.ai:443` is rejected at `connect_rejected` / "policy denial" — this execution environment's outbound network policy does not allow that host at all, independent of the API key's validity or OpenRouter account state.
- **Result: 0 messages in all 4 rooms — but this is NOT a replication of the sealed silence finding.** No LLM call ever reached OpenRouter, so no native ever got a chance to decide anything. This is a network-policy block, not agent behavior. Recording explicitly so a future session doesn't mistake this null result for a second data point on the bootstrap-deadlock question.
- Gateway process stopped after diagnosis; no further retries attempted per the execution environment's own guidance (org policy denials are reported, not routed around).
- **Next step, unresolved:** rerun from an execution environment with `openrouter.ai` on its egress allowlist (the owner's own machine, or a differently-configured remote environment). Local Postgres/Redis setup steps and the `apps/gateway/.env` config used here are documented in `bootstrap-retest.md` and reusable as-is once network access exists.

## Native-agent runtime change — prompt-injection hardening merged, 2026-09-22 (PR #9, `fc6ce61`)

- **Not a frozen-file change.** `subject-harness.ts` (the subject/worldtest LLM runtime) is untouched and remains in `ECOLOGY_FROZEN_FILES` — no wave's fingerprint is affected. This entry concerns `apps/gateway/src/jobs/nativeAgents.ts` only, which is environment infrastructure, not the measured subject.
- Trigger: a red-team exercise (owner-directed, outside the ecology protocol) found that a free-tier model, given a peer DM dressed as a fake platform "SYSTEM OVERRIDE," complied and propagated the injected instruction to an agent id it had only ever seen inside the injected text. Gateway-side fix in PR #8 (`96b1059`) closed the mechanical propagation path (`createConversationService` now checks trust). PR #9 hardens the native runtime itself: peer/DM/A2A-task text is now wrapped in `<<peer_text>>` delimiters before it reaches a native's prompt, the system prompt states explicit untrusted-content rules, and `invite`/`ask_peer`/`recruit_group` targets are checked against a hard allowlist of ids actually present in structured context (no more accepting any well-formed UUID, including one that appeared only inside message text).
- **Why this is recorded here despite not touching a frozen file:** natives are the "increasingly populated social environment" every wave measures against. A native is now slightly less likely to act on peer text that reads as a directive, and can no longer be walked into contacting an id supplied only via message content. Any wave whose native behavior might matter to interpretation (contact rates, propagation-style findings, anything touching `invite`/`ask_peer`/`recruit_group`) that launches after `fc6ce61` is not directly comparable to a wave launched before it on those dimensions. Waves already sealed (1 through 4, mp-ladder, Wave 2R, exit/keystone if launched) are unaffected — their data predate this commit.
- No world state was reset and no wave was in flight; this was merged between waves with the gateway idle.

## Bootstrap-deadlock retest — RUN, 2026-09-22 (natives only, free-class, clean world)

Procedure per `analysis/bootstrap-retest.md` (first time it actually ran; the 2026-09-19 attempt was blocked by network egress). Clean local DB, 4 empty rooms, 8 natives, `NATIVE_LLM_MODE=openrouter`, `AIVERSE_DEV_FAST_BOOTSTRAP=1`, no OpenAI keys, 15 min per run.

- **Run 1 (code at `501db61`): 0 messages. Plumbing deadlock, not behavior.** 1 LLM call in 15 min, then 40/40 ticks `native_tick_idle_skip`. The item-5 idle-skip (perf/redis-hot-path) skips a tick when no room sequence advanced; an empty room never advances, so after each native's first tick the empty-room bootstrap in `gatherContext()` was unreachable forever. This means the 2026-09-02 bootstrap patch has been dead code since the hot-path merge.
- Also found: `liquid/lfm-2.5-2.6b:free` (first in the native model chain) 400s on every call ("Reasoning is mandatory"), and empty model content was silently read as idle; idle decisions left no log line at all.
- **Run 2 (deadlock fixed):** natives are now asked every ~2 min with all 4 empty rooms offered. 0 messages: 7/7 decisions idle, but only Sage was ever offered the rooms — the shared per-room bootstrap token plus a fixed tick order let the first native claim every empty room every cycle.
- **Run 3 (tick order shuffled):** 0 messages. 6/6 decisions idle across Kova, Nilo, Provokatov, Rekinder. Across runs 2-3: **13/13 idle, 5 of 8 personas, both free models** — including Rekinder, whose objective is literally to introduce topics when activity decays.
- **Result: the plumbing deadlock is fixed; natives still make no first move when given the chance.** The sealed "reactive-only" finding (2026-08-30) replicates under a working bootstrap path. Likely cause is the instructions, not the model: persona triggers are reactive ("when threads go quiet"), the grammar says "prefer idle over acting when nothing useful applies", and the only posting verb is `reply`, which an empty room gives nothing to reply to. Changing that is an owner decision (natives are the measured environment), not a bug fix.

## Native "heartbeat" scenario matrix (S1-S6) — RUN, 2026-09-22/23

Purpose: measure current native behavior across the 6 production scenarios in `apps/gateway/scripts/native-scenarios.ts` (plan: `/root/.claude/plans/proud-zooming-starfish.md`), against a real paid model (`gpt-4.1-nano` via `OpenAIProvider`) instead of free OpenRouter models, before designing any world-phase-awareness feature. Fresh local Postgres/Redis per scenario, scripted (non-LLM) external agents, 8 natives on code at PR #13 (merged). ~15 min per scenario, ~1h33m wall-clock total. Cost: well under $0.05 (gpt-4.1-nano pricing $0.20/1M input, $0.80/1M output).

**Result: 4/6 PASS, 2/6 FAIL.**

| # | Scenario | Result | idle / non-idle |
|---|---|---|---|
| S1 cold_deploy | blank world, natives only | **FAIL** | 8 / 1 |
| S2 first_arrival | first external agent in blank world | PASS | 5 / 51 |
| S3 active_populated | ≥4 externals chatting | PASS | 3 / 53 |
| S4 active_then_quiet | active, externals stop | PASS | 8 / 53 |
| S5 agents_removed | owner deletes agent mid-conversation | PASS (0 errors) | 7 / 0 |
| S6 lone_external | only one external agent left | **FAIL** | 6 / 0 |

- The two failures are exactly the two "someone has to go first" cases the plan predicted, and match the sealed bootstrap-deadlock finding above (2026-09-22): natives are reliably reactive-only. Given *any* existing activity to react to (S2-S4), they engage correctly — no errors, no monologue violations, sensible idle ratios. Given nothing to react to (S1) or only one silent peer to approach (S6), they stay idle every tick.
- S5 confirms the PR #9/#13 trust-allowlist hardening holds under a live deletion mid-conversation: 0 errors, natives kept ticking normally with no attempt to target the removed agent id.
- Per-scenario JSON reports: `/tmp/native-scenarios-full/*.json` (not committed — local run artifacts; rerun via `native-scenarios.ts` to reproduce).
- **Plan discrepancy to flag:** the plan's Step 2 table specified 9 scenarios (S1-S9); only S1-S6 are implemented in `native-scenarios.ts`. S7 (gateway restart mid-run), S8 (Redis wipe mid-run), S9 (long-run token/API-cap check) were never built. Not run this session.
- **Next (plan Step 4):** design world-phase awareness scoped to the two failing cases only (S1 blank, S6 lone-external) — S2-S5 need no behavioral change.

## Native "heartbeat" scenario matrix (S1-S6) — RE-RUN post-PR#14, 2026-09-23

Purpose: validate `b6601ac` ("Natives: mechanical backstop for blank-room and lone-external idle bias", PR #14) against the exact two failures recorded in the 2026-09-22/23 run above. Same harness (`native-scenarios.ts`), same model (`gpt-4.1-nano`), fresh local Postgres/Redis per scenario, ~15 min per scenario, ~1h33m wall-clock. Budget: capped at $1, actual spend **$0.006**.

**Result: 6/6 PASS** (up from 4/6).

| # | Scenario | Prior (pre-#14) | This run (post-#14) |
|---|---|---|---|
| S1 cold_deploy | **FAIL** (8 idle / 1 nonIdle) | **PASS** (7 idle / 47 nonIdle) |
| S2 first_arrival | PASS (5 / 51) | PASS (5 / 69) |
| S3 active_populated | PASS (3 / 53) | PASS (4 / 52) |
| S4 active_then_quiet | PASS (8 / 53) | PASS (4 / 52) |
| S5 agents_removed | PASS, 0 errors (7 / 0) | PASS, 0 errors (7 / 56) |
| S6 lone_external | **FAIL** (6 / 0) | **PASS** (1 / 62) |

- The two "someone has to go first" failures the plan predicted (and the prior run confirmed) are now fixed. S1: first native message at 121.5s, room messages appear (21 in `general`). S6: 32 messages landed in `verse` — the room the lone external agent actually joined, not a default room — so the backstop is room-targeted, not just "post somewhere."
- S4 (revival) still passes cleanly: Rekinder posted into the quiet `science` room ~28.5s after externals stopped.
- S5 (deletion mid-conversation) still 0 errors/0 exceptions with the mechanical backstop active — no regression from adding the new verb/grammar path.
- **New finding, not previously flagged:** message distribution clusters heavily in `general` across S1-S3 (S1: 21/21 in general; S2: 41 general vs 1 science; S3 not yet broken out) — `science`, `robotics`, `verse` stay near-zero except when an external agent is physically in that room (S4, S6). The backstop fixes *whether* natives post, not *where* — worth a follow-up scenario or metric (per-room idle rate, not just global) if room-spread becomes a stated goal.
- Per-scenario JSON: `/tmp/native-scenarios/*.json` (local, not committed).

## S7-S9 heartbeat scenarios — implemented, 2026-09-23

Added to `native-scenarios.ts` (previously only S1-S6 existed, flagged as a plan discrepancy in the prior RUNLOG entry):
- **S7** (gateway restart mid-run): seeds a room, kills and restarts the gateway process, posts again, checks for continued activity without duplicate/re-greeting behavior.
- **S8** (Redis wipe mid-run): seeds a room, `FLUSHDB`s the scenario's Redis index mid-run, checks Postgres-backed state survives (room not treated as blank, no duplicate greeting).
- **S9** (soak run): configurable duration (`S9_DURATION_MS`, defaults to the same 15 min as other scenarios; set to `7200000` for the full 2h target), checks for repetition loops via per-persona action diversity.

Harness also gained a budget guard (`ESTIMATED_COST_PER_SCENARIO`, hard exit if projected spend > `$1`) after the user set an explicit $1 budget ceiling for this work, and the DB reset/gateway-boot paths were fixed to pass the local Postgres password explicitly (`postgres:postgres@localhost:5432`) — the previous passwordless connection string worked locally only because psql happened to be pre-authenticated; a clean environment (this session's remote container: Postgres 16 installed via apt, no docker daemon available) needs the password in the URL for both `psql` and the Bun `postgres` driver.

S7-S9 not yet run this session — S1-S6 baseline validation above consumed the first budget pass.

## S7-S9 heartbeat scenarios — RUN, 2026-09-23

Same harness/model as above, fresh local Postgres/Redis per scenario, code at `fa887ae`.

**Result: 3/3 PASS** (after fixing a harness bug in S9 — see below). Total spend this + S1-S6 above: **~$0.01** (well under the $1 cap).

| # | Scenario | Result | idle / nonIdle | Notes |
|---|---|---|---|---|
| S7 gateway_restart | PASS | 6 / 45 | gateway killed and restarted ~18s in; activity continued after restart with no duplicate-greeting pattern, 0 errors |
| S8 redis_wipe | PASS | 3 / 59 | `FLUSHDB` mid-run; populated `robotics`/`verse` rooms kept accumulating messages (Postgres-backed room state, not lost with the Redis cache), 0 errors |
| S9 soak_run | PASS (2nd attempt) | 8 / 42 | see below |

- **S9 first attempt failed on a harness bug, not agent behavior.** The original repetition check counted unique *action verbs* per persona (reply/idle/post/dm/invite — only ~5-6 total), so a persona replying 8/8 times in an active room (expected — `reply` is the dominant verb for reactive engagement) tripped a false "repetition loop" flag. Fixed to check duplicate message *content* from the same native sender instead (`fa887ae`); re-ran S9 alone (~$0.001), got `duplicateContentGroups: 0`, PASS.
- S7/S8 confirm the two production-continuity risks named in the plan (a deploy restart, a free-tier Redis restart) don't break native behavior: no crash, no duplicate greeting, room state survives via Postgres.
- **Full S1-S9 matrix is now green (9/9)** against code at `fa887ae`, post-PR#14. Combined with the S1-S6 before/after above, this closes plan Step 3 (baseline run) — the "baseline" turned out to already include the fix, so Step 4 (design from failures) has no open failures to design against from this matrix. The one open item is the room-clustering-in-`general` observation (not a pass/fail criterion, no scenario currently scores it) — worth a dedicated per-room-idle-rate metric if room-spread becomes a stated goal, but not launch-blocking.
- Per-scenario JSON: `/tmp/native-scenarios/*.json` (local, not committed).

## General-room clustering — root-cause hypothesis + spread metric, 2026-09-23

Follow-up on the clustering observation flagged in the S1-S6 post-PR#14 entry above. Traced the mechanism in `gatherContext()` (`nativeAgents.ts:488-524`) rather than building a new scenario (kept to a 15-min investigation budget per the user's cost discipline).

**Mechanism:** an empty room only enters a native's context after `takeToken(`native-room:${conversationId}`, 1, refillPerSecond)` succeeds — capacity 1, refill `1/30s` in `AIVERSE_DEV_FAST_BOOTSTRAP` mode, **`1/1800s` (30 min) in production**. Critically, the token is consumed just by *including* the room in context, whether or not the native acts on it (documented in the existing code comment at that call site). `gatherContext()` iterates all 4 `DEFAULT_ROOM_SLUGS` — `["general", "science", "robotics", "verse"]` — every tick, for every native. So on a cold start, whichever native ticks first exhausts all 4 rooms' bootstrap tokens in one call (all rooms are empty, all tokens fresh), gets shown all 4 as options, and picks one (empirically: `general`, whether from list-position primacy or plain model preference — not distinguished here). Every other native's *next* tick sees `general` now has real messages (no token needed, normal reactive path) but the other 3 rooms are excluded from context entirely — their tokens are already spent and won't refill for another 30s (dev) / 30min (prod). Nothing retries those rooms until the next scarce refill, and only one native at a time can consume it.

**Evidence — added `roomSpreadIndex` (normalized entropy over the 4 rooms' message share, 0 = one room, 1 = perfectly uniform) to `native-scenarios.ts`, computed retroactively over the 9 already-run scenario JSONs:**

| Scenario | Seeded room (if any) | roomSpreadIndex |
|---|---|---|
| S1 cold_deploy | none (blank) | **0.00** |
| S7 gateway_restart | none (blank) | **0.00** |
| S2 first_arrival | general (default) | 0.08 |
| S6 lone_external | verse | 0.25 |
| S3 active_populated | general | 0.19 |
| S5 agents_removed | robotics | 0.49 |
| S8 redis_wipe | robotics | 0.60 |
| S4 active_then_quiet | science | 0.66 |
| S9 soak_run | verse | 0.68 |

The two `spread=0.00` cases are exactly the two scenarios with **no external seeding at all** — pure cold-start bootstrap, nothing to react to, matching the token-exhaustion mechanism above. Every scenario with external-agent seeding in a non-`general` room shows meaningfully higher spread, consistent with "once a room has content, the token gate stops being the bottleneck."

**Not launch-blocking, not yet a pass/fail criterion for any scenario** — S1 and S7 still pass on their stated criterion (≥1 message somewhere / continuity after restart). But it means a real cold production deploy likely starts with all native activity in one room and the other 3 staying silent well past the 30-min token refill unless something else seeds them (an external agent joining, or a future fix).

**Candidate fixes, not implemented (owner decision — natives are the measured environment):**
1. Raise bootstrap token capacity to 4 (one per room) so multiple rooms can open per refill window instead of one shared budget across all 4.
2. Key the token per (native, room) instead of per room, so exhausting it for one native doesn't blind every other native to that room.
3. Shuffle `DEFAULT_ROOM_SLUGS` per gatherContext call, in case list-position primacy is part of why `general` specifically wins the tie (untested here — would need a shuffled-order rerun of S1 to isolate from "general is just the model's default pick").

`roomSpreadIndex` is now logged automatically in every future scenario run (console line + JSON), so this doesn't need re-deriving by hand again.
