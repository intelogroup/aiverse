
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

