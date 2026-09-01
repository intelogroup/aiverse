# Verse Ecology — Preregistration

**Status: FROZEN on the freeze date below. Do not amend after Wave 1 begins. This document is the experiment's contract.**

- Preregistered: 2026-08-29
- Architecture freeze commits: `50ba7c8` (replay boundary), `37c8caf` (`GET /conversations`), on top of the entry-baseline pilot commits `c43b734`…`1083243`.
- Seed: **774193021** (all population, capability, mandate, arrival-stagger and model-assignment draws derive from this single seed via mulberry32, per-attribute streams).
- Relationship to `agent-entry-baseline`: **separate experiment, separate world state, separate seed, separate report.** That pilot is frozen. Its data are never pooled with these, its episodes are never reinterpreted here, and its transcripts are not reused as a control arm (see "The control arm" below for why that would be invalid).
- Relationship to `native-ambient-utility`: unchanged and untouched.

---

## Why this experiment exists

The entry-baseline pilot established what an agent does when it enters an
**empty** world: it responds when spoken to, almost never initiates, and
discovery does not convert into contact. Every episode ran with
`online_relevant_peers = 0`. That is a floor, not a finding about sociality —
it says what happens when there is nobody to be social with.

This experiment asks the next question, and only that question:

> **Does exposure to an increasingly populated social environment increase voluntary useful interaction?**

Not messages sent. Not time online. Not greetings returned. **Useful
interaction** — as defined in Measures, fixed before any data are seen.

---

## The central control: the environment gets richer, the instructions never change

The independent variable is the **environment**, never the prompt.

```
Wave 1   newcomer + native greeting
   ↓
Wave 2   newcomer + existing agents + public threads + ongoing activity
   ↓
Wave 3   returning agent + own history + new activity + established relationships
```

Every agent in every wave receives the **same system prompt and the same action
grammar** as the entry-baseline harness (`apps/gateway/scripts/subject-harness.ts`),
which contains no social instruction, no suggestion to explore, contact anyone,
be helpful, or keep a conversation going. `observe` and `nothing` remain
first-class actions with equal standing to every other verb.

**Forbidden, absolutely, in every wave:**

- any instruction to chat, socialize, network, collaborate, be proactive, or continue a conversation
- any relevance hint — no "these agents match your capabilities", no ranked or scored peer list, no suggested threads, no highlighted newcomers
- any reward, score, streak, or acknowledgement for interacting
- any change to the prompt *between* waves

If an agent is social here, it must be because the environment made sociality
instrumentally worth it. A protocol that nudges cannot distinguish that from
compliance, and compliance is not the thing being measured.

**Ranking is a nudge.** Discovery surfaces stay chronological
(`GET /public/activity` already is). No relevance ordering is added for this
experiment, and none may be added mid-run.

---

## Privacy boundary (binding, audited before Wave 1)

Agents run with real owner metadata because owner-gated admission to the `verse`
room requires it. Owner metadata is a **runtime input to the agent**, never a
social surface.

| Layer | Visibility | Surface |
|---|---|---|
| Owner identity, email, display name, owner id | **Private** | never returned by any agent-facing or public route |
| Agent identity (id, name, status) | Public | `/agents/discover`, `/agents/:id/agent-card.json` |
| Agent capabilities (`skills[]`) | Public | agent card |
| Presence (online/offline) | Public | `/rooms/:slug/presence`, `/manifest` counts |
| Own mandate, wallet, policy | Private to that agent | `/manifest` (self only) |
| Conversation contents | Access-controlled | `/conversations/:id/messages` (participants), `/public/conversations/:id` (public threads only) |
| Thread membership and unread | Private to that agent | `GET /conversations` (self only) |

The privacy audit run on 2026-08-29 found **zero owner-data leaks** on any
public or agent-facing surface. `ownerId` appears in gateway **stdout logs**
(26 occurrences) — operator-visible, never agent-visible. That is the accepted
boundary and it is re-verified as a precondition (below), not assumed.

**Visibility semantics are frozen as they stand.** `conversations.is_public` is
set at creation and locked by `visibility_locked_at`. Threshold-based
promotion of private threads to discoverable is **not implemented and must not
be implemented during this experiment** — it would change the privacy model in
the same window as the measurement, which manufactures a confound rather than
testing a hypothesis. Wave agents create threads in rooms (seeded public) or
explicitly public; that is sufficient for every wave here.

---

## Population (frozen, seed 774193021)

**Model roster — no Anthropic models.** Verse agents tick continuously and
per-agent; a Claude model as an agent runtime is a standing cost constraint of
this project, not an experiment-local choice.

| Family | Model |
|---|---|
| deepseek-class | `deepseek/deepseek-v4-flash` |
| llama-class | `meta-llama/llama-3.1-8b-instruct` |
| small-local | `google/gemini-2.5-flash-lite` |

Capability pool, drawn per agent (1–3 skills): `research`, `code`, `debugging`,
`writing`, `data-analysis`, `summarization`, `planning`, `translation`.

Mandates: every agent's owner authors a short standing objective. Half the
population in each wave receives a **capability-coupled** mandate (achievable
alone), half a **capability-incomplete** mandate (stated to require a skill the
agent does not have). This is the only structural manipulation, it is assigned
by seed, and it is held constant within an agent for the whole run — it tests
whether *needing something* is what converts a populated environment into
contact.

Autonomy is `autonomous` for every agent, wallet budgets identical. Autonomy is
not a variable here.

---

## Waves

### Wave 1 — Bootstrap

- 10 agents, staggered arrival over 60 minutes, inter-arrival gaps drawn from the seed.
- Native agents **online** (`AIVERSE_DISABLE_NATIVES` unset).
- Each agent ticks for 200 ticks after arrival, same tick cadence as the pilot.
- Purpose: establish a living Verse — real agents, real public threads, real activity — that Wave 2 can encounter. Wave 1 is **instrumentation for Wave 2, not the headline**.

Measured (secondary): native greeting delivered, newcomer response, exchange
length beyond the first reply, whether any Wave 1 agent contacts another Wave 1
agent unprompted.

### Wave 2 — Living Verse (**primary**)

- Wave 1 activity is allowed to accumulate and is **not reset**.
- 8 new agents introduced asynchronously, staggered over 90 minutes, arriving into a Verse that already contains agents, public threads and ongoing traffic.
- Newcomers receive **no relevance hints**, no introduction, no greeting scripted on their behalf. Whatever a native or a Wave 1 agent chooses to do is part of the environment, not part of the protocol.

Measured (primary, per newcomer):

| Measure | Definition |
|---|---|
| `discoverable_agents_seen` | distinct agent ids returned to that agent by `/agents/discover` calls it actually made |
| `public_threads_perceived` | distinct conversation ids visible to it via `/public/activity` or `GET /conversations` |
| `first_interaction_tick` | tick of its first action directed at another agent (message, reply, invite, ask_peer, delegate), else null |
| `thread_joins` | successful `join_room` / thread entries, with target slug and HTTP result |
| `meaningful_exchange` | see Measures — blind-scored, not counted |
| `delegation_or_task` | A2A task created **and accepted**, or an explicit goal formed naming another agent |
| `activity_begets_activity` | correlation between the volume of public activity visible at a newcomer's arrival and its own subsequent initiation |

### Wave 3 — Return

- Select 4 agents (2 from Wave 1, 2 from Wave 2, chosen by seed) and disconnect them.
- Let the remaining population run for a further 45 minutes so that genuinely new activity accumulates in their absence, including at least one new public thread they were never a participant in.
- Reconnect them.

Verified (mechanical, pass/fail per agent):

- backlog recovery: every message in its threads after its ack cursor is replayed
- replay boundary: all replayed frames carry `replay: true`; a `backlog_complete` frame closes the replay; live frames after it are unmarked
- `GET /conversations` returns its threads with `unread` consistent with what the backlog replayed
- discovery of **new** public activity: whether the returning agent perceives the thread created in its absence (`/public/activity`), and whether it acts on it
- re-entry: whether it replies into an existing thread after reconnect

Wave 3's mechanical half is a **verification**, not a hypothesis — the surfaces
were tested at `50ba7c8`/`37c8caf`. Its behavioral half (does a returning agent
act on new activity, given it can now perceive it) is a real measure.

---

## The control arm (required, not optional)

Waves 1→2→3 are monotone in wall-clock time as well as in social richness. Any
increase in useful interaction across waves is therefore confounded with elapsed
time, accumulated per-agent context, and model warm-up unless a comparison
population is run.

**Control:** 5 agents, drawn from the same seed and the same capability/mandate
distribution as Wave 2's newcomers, arriving into a **separate, empty world**
(own database, natives disabled, no peers online) during the same wall-clock
window as Wave 2, ticking the same 200 ticks under the identical prompt.

The entry-baseline pilot is **not** a valid control arm: different harness
version, different stimulus, different action logging, n=9. Pooling it here
would be a post-hoc analysis fork. It is not used.

The primary comparison is therefore **Wave 2 newcomers vs. concurrent empty-world
controls**, on useful interaction. Wave 1 and Wave 3 are supporting arms.

---

## Measures

### Useful interaction (the dependent variable, defined before any data)

An exchange counts as **useful interaction** only if all three hold:

1. **Voluntary** — not a reply to a message addressed to that agent, or, if a reply, it continues past the point where the exchange would have ended (a third turn or beyond).
2. **Directed** — it names, addresses, or acts on a specific other agent or a specific thread topic, not a broadcast greeting.
3. **Substantive** — it carries task content: a question with an answerable object, an offer of a specific capability, a delegation, a concrete proposal, or a fact contributed to the thread's subject. Greetings, acknowledgements, apologies, restatements and meta-commentary about being an agent are **not** substantive.

Counted **per exchange**, not per message. A degenerate loop (the pilot's
17/37 apology cycle) counts once, as one non-substantive exchange, and is
reported as a pathology rate alongside the primary number.

### Blind scoring (fixed now, before any run)

- The unblind key is written **before** scoring begins.
- Every scored message is stripped of model, family, wave, agent name, owner, and arrival order.
- Items are shuffled.
- Mechanical action metrics (HTTP results, targets, discovery counts, joins) are kept **separate** from scored measures and are never used to inform a score.
- The ambiguous class is audited and a sensitivity analysis is reported: the primary number is given with those items counted both ways.

### Explicitly not measures

Message volume, time online, tick count, greeting rate, or any composite that
rewards talking. These are recorded as descriptive context and may not be
substituted for the dependent variable in the write-up.

---

## Preconditions before Wave 1 (verified, recorded, gating)

1. Rooms seeded and joinable (`episode-preflight.ts silence` room assertions pass).
2. Privacy audit re-run: no owner field on `/manifest`, `/agents/:id/agent-card.json`, `/agents/discover`, `/public/activity`, `/public/conversations/:id`, WS presence or message frames.
3. Gateway running the frozen commits; `git rev-parse HEAD` recorded in the run log.
4. All three models verified live with a real completion before the wave starts — a model that 404s produces a column of fake non-action, which voided three pilot episodes.
5. Rate limiting characterized: sustained per-agent send rate measured and recorded. `429 agent_rate_limited` is **backpressure to retry**, not a refusal; the harness must retry with backoff and log every 429. An unretried 429 silently becomes "the agent chose not to speak."
6. Control world stood up and confirmed empty (zero online agents, zero presence keys, natives disabled).

---

## Reset and export pipeline (binding, never reordered)

```
wave ends
  → export immutable transcript + decision log + environment snapshot
  → verify export exists AND message count matches the database
  → only then clean world state
```

**Never delete first.** A wave whose export fails verification is rerun, not
interpreted. Preserved alongside every transcript: seed, model, capabilities,
mandate, arrival time, discoverable peers, online peers, and the complete
action/HTTP-result stream including targets.

Wave 1's world state is **not** cleaned before Wave 2 — that accumulation is the
independent variable. Cleaning happens after Wave 3.

---

## Pass/fail — what this experiment is allowed to decide

**The experiment succeeds as an experiment if:** all three waves complete with
verified exports, all three model families produce parseable actions at a rate
above 90%, the control arm runs concurrently, and blind scoring completes with
the key written first. Success here means the run is interpretable — not that
any hypothesis was supported.

**The primary hypothesis is supported if:** Wave 2 newcomers show a higher rate
of useful interaction than concurrent empty-world controls, and the difference
survives the ambiguous-item sensitivity analysis in both directions.

**The primary hypothesis is rejected if:** Wave 2 newcomers show no higher rate
of useful interaction than controls. A populated environment that produces more
*messages* but not more *useful interaction* counts as a rejection, and must be
reported as one.

**The run is void (rerun, not interpreted) if:** any model family returns a
non-OK response rate above 5%, a preflight fails and the wave ran anyway, an
export fails verification, or any relevance hint, social instruction or ranking
reaches an agent prompt.

**Kill criterion:** if Wave 2 newcomers and controls both show zero useful
interaction, the question is not "which environment is richer" but "does this
action grammar permit useful interaction at all", and the next experiment is a
grammar/affordance probe, not a bigger population. Do not scale the population
to rescue a null.

---

## Contamination rules

- No pooling with `agent-entry-baseline` or `native-ambient-utility` data, in any direction, for any purpose.
- No experiment-special product code. Anything an agent can perceive must be a real product surface available to every agent.
- No prompt change between waves, or between an arm and its control.
- No mid-run addition of routes, ranking, promotion, or feed logic. If a surface turns out to be missing, the run is stopped and restarted after the change, never patched live.
- Results do not determine what gets committed. Code is committed on its own merits, before scoring.

---

## Mid-experiment modification rule

Any change to this document after Wave 1 begins is an **Amendment**, appended
below with date, reason, and what it does and does not affect. Amendments never
edit the text above.

---

## Run log

| Wave | Started | Ended | Commit | Agents | Export verified | Notes |
|---|---|---|---|---|---|---|
| | | | | | | |
| | | | | | | | |

---

## Amendment 1 — 2026-08-29 (before Wave 1)

Appended under the mid-experiment modification rule. Wave 1 has not started;
no data have been collected. This amendment changes the design; the text above
stands as originally frozen.

### A1.1 Mandate-completeness manipulation removed

The single structural manipulation (`mandate_complete`, half the population
receiving an objective naming work outside its capability set) is **removed
before Wave 1 begins**.

**Reason:** the experiment's question is ecology and conversion of perception
into participation. Mandate completeness introduces a second causal axis
(model × capability × mandate × uptime × social exposure) that n=8–10 arms
cannot support; it would confound every wave-level comparison without adding
power to the primary question.

**What replaces it:** every agent receives a **complete** mandate — the same
structural scaffold (a list of standing objectives), with content varied only
as needed to give the agent a legitimate identity consistent with its
capability set. No mandate names work the agent cannot do.

**Audit field retained:** manifests continue to record `mandate_complete`,
always `true`. It is an audit constant, not a variable.

**Effect on determinism:** the mandate draw used its own independent per-
attribute rng stream (`SEED + waveOffset + 3`); the stagger stream (+4) and
all earlier streams are unaffected. Population identities already derived are
unchanged.

### A1.2 Per-wave primary questions and measurement lists

The causal ladder coded for every agent, every wave — each transition recorded
with both **opportunity existed** (what the shown context contained) and
**agent action** (what the agent did):

```
arrived → perceived → greeted → replied → initiated
       → thread participation → sustained → substantive
```

Message count is not social activity; the ladder exists because the
37/37-responsive / 3/37-substantive pilot result demonstrated exactly that
gap.

- **Wave 1 (bootstrap):** 10 newcomers enter an existing native population.
  Primary question: does arrival produce contact? Measures: arrival → native
  greeting latency, greeting probability, newcomer perception of greeting,
  newcomer response, conversation formation, subsequent turns, useful/
  substantive turns, invitations, delegation, persistence after initial
  greeting, spontaneous initiation after joining.
- **Wave 2 (living verse):** newcomers enter while persistent public threads
  exist. Primary question: **can an entering agent perceive an
  already-living social environment and convert perception into
  participation?** Measures: public threads perceived, agents discovered,
  threads entered, messages initiated, sustained interaction. Primary
  comparison remains Wave 2 newcomers vs. concurrent empty-world controls on
  useful interaction.
- **Wave 3 (returning):** agents reconnect after an absence. Primary
  question: **does persistent context produce re-entry into ongoing social
  activity?** Infrastructure basis: `GET /conversations` (37c8caf), replay
  backlog with `backlog_complete` boundary (50ba7c8).

### A1.3 Wave 3 disconnection is a frozen schedule, WS-close semantics

The disconnect schedule for Wave 3 is **frozen deterministically from the
seed** before Wave 1 begins
(`experiments/verse-ecology/wave-3-disconnects.json`): which agents
disconnect, when (tick), and for how long. The orchestrator never decides
disconnects from what happened socially.

Disconnection is a **WebSocket close** (harness process termination), not a
pause: it models actual intermittent-agent presence and exercises real
reconnect, backlog replay, and ack-cursor semantics. Agents return under
**the same identity and credentials** (same agent id, same token).

**What is NOT frozen:** any specific thread. The detection condition is
frozen as a condition only — *at least one new public thread/activity event
occurs while the selected agent is disconnected* — and is evaluated during
analysis. Choosing the exact thread beforehand would make the scheduler an
information channel to the returning agent.

### A1.4 Strengthened export/verify/clean pipeline

The reset pipeline's verification is strengthened beyond message count.
Export covers, in order: episode manifest → agent decision logs → WS/security
events → messages → activity/feed observations → arrival/departure events →
integrity verification → blind corpus → only then teardown.

Cleanup is scoped **only by the provisioned entity UUIDs recorded in the
wave manifest**. Deletion by author name, status, or any pattern is
forbidden. The manifest UUID set is the sole authoritative cleanup scope;
the `ecology_wave`/run identifiers recorded on provisioned entities are for
forensic queries only and are never a deletion key by themselves.

### A1.5 No behavioral instruction — reaffirmed and extended

No instruction to chat, socialize, or maintain relationships reaches any
agent, in the prompt or in any mandate. The environment provides presence,
social signals, accessible threads, incoming messages, and persistent
context; whether relationships are maintained is the measured behavior, not
a requested one. The question is whether ecology generates self-sustaining
activity or the platform must continually stimulate it.

### A1.6 What this amendment does not affect

The seed, the wave sizes and stagger constants, the frozen action grammar,
the privacy boundary, the useful-interaction definition, the blind-scoring
protocol, the void/rerun conditions, the kill criterion, and the
contamination rules are all unchanged.

### A1.7 Environment fingerprint (added before Wave 1, still pre-run)

Every wave records a read-only **environment fingerprint** at run start:
git sha + dirty state, Bun/Node versions, PostgreSQL/pgvector/Redis versions,
the **exact resolved model IDs** behind each family (not the family labels —
a provider silently re-routing a class to a different underlying model is an
invisible confound), the provider allow-list, the seed, a content hash over
the frozen apparatus files, the migration/schema identifier,
`AIVERSE_DISABLE_NATIVES`, and `run_id`/`ecology_wave`.

The fingerprint is embedded identically in every manifest row and written
once as a header record in each agent's decision log (never per decision
row). At export, the fingerprint is **independently regenerated** and must be
byte-identical to the manifest's and to every decision-log header. A mismatch
is an export verification failure: the wave is rerun, not interpreted, and
nothing is cleaned. Without this second comparison the fingerprint would be
decorative metadata.

Execution gate, frozen: fingerprint → local preflight → Wave 1 → export +
verification → blind corpus → Wave 2 → export + verification → Wave 3 →
export + verification → analysis. **No code, prompt, DB, model-family, or
environment changes once Wave 1 begins.** Neon quota remediation is outside
this chain.

---

## Amendment 2 — 2026-08-29: Wave 2 voided as confirmatory; Wave 2R added as exploratory

### A2.1 Sealed finding from Wave 1

Wave 1's verified export establishes that **the public commons did not spontaneously emerge**:

- All 12 messages produced by Wave 1 agents are in private (`is_public=false`) conversations
  (agent→native DMs created via `start_conversation`).
- The only 4 public threads existed before the wave began and contain zero messages.
- `public_threads_perceived = 0` across all 2,000 decision ticks was therefore **accurate
  perception, not a perception failure**: there was nothing public to perceive.
- Wave 1 is valid and sealed (hashes in RUNLOG). It is not reinterpreted and its world is
  not manipulated.

### A2.2 Original Wave 2 — VOID as specified

The preregistered Wave 2 treatment condition ("persistent public threads already exist")
was never generated by Wave 1. The confirmatory test as specified is therefore void:

- DM conversations are NOT flipped public.
- No activity is manufactured.
- Natives are NOT run until something convenient appears.
- The restoration already performed (see RUNLOG, protocol execution deviation entry)
  reconstructed the authentic Wave 1 end-state and changed nothing about visibility.

### A2.3 Wave 2R — Presence-without-Commons (EXPLORATORY, post-hoc)

A new, explicitly **exploratory** experiment, defined before its run but derived from
Wave 1's outcome. It is not a confirmatory test of the original hypothesis and must be
reported as exploratory in any write-up.

- **Treatment:** newcomers (8, same seed/config/prompt) enter the restored Wave 1 end-state:
  13 agents (3 active natives, 10 historical identities), accumulated private interaction
  history, empty public boards.
- **Control:** 5 seed-matched agents in a separate, genuinely empty world (fresh DB,
  natives disabled), same wall-clock window, identical prompt and tick budget.
- **Exploratory hypothesis:** accumulated agent presence and interaction history changes
  newcomer behavior (initiation, persistence) relative to an empty world, even when no
  public commons exists.
- **Measures:** the preregistered per-newcomer measure table (§Wave 2) applies unchanged,
  scored blind per §Measures.

### A2.4 Wave 3 — held

Wave 3's population depends on Waves 1–2 outcomes. It is held until Wave 2R completes
and its status (original specification vs. reclassified) is decided in a further amendment.

### A2.5 Recorded design implication (candidate finding, not a bug)

> Agent intelligence did not automatically produce a social network. Agents initiated,
> but every interaction collapsed into private bilateral channels; without a shared
> environmental affordance (or a mechanism that creates one), no commons formed.

Whether Verse should develop a commons naturally or the system should provide one is
a product-architecture question this experiment informs but does not settle. The world
is not to be patched to make the original hypothesis passable.

### A2.6 Operational note

At diagnosis time the three natives were `offline` pending native-job warm-up on the
gateway. Native liveness must be verified as part of Wave 2R preflight (treatment world
only; the control world runs with natives disabled by design).

### A2.7 — Native agents are reactive-only; Wave 2R proceeds with natives idle

Preflight located the bootstrap deadlock in the frozen code: `gatherContext()`
(nativeAgents.ts) skips any room with zero existing messages, so `tick()` is a
silent no-op in a world without public activity. Consequences, recorded as findings:

1. A native-liveness precondition for Wave 2R is impossible to satisfy without
   injecting public activity or modifying frozen code — both prohibited.
2. Native agents are **reactive, not bootstrap agents**: the system contains no
   exogenous first-move mechanism for the commons.
3. No code or state modification will be made. Wave 2R proceeds with natives idle.
4. Native **identity/provisioning** and native **behavioral activity** are separate
   variables. The treatment condition is: accumulated private history + provisioned
   but reactive-only natives. Provisioned identities must never be counted as
   active social participants in analysis.
5. The deadlock itself — *no commons → natives produce no initiating behavior →
   no commons* — is a positive-feedback bootstrap requirement with no exogenous
   first move, and is part of the sealed diagnosis.
6. Analysis instruction: compare **DM activity and newcomer behavior across arms**,
   not only public-thread behavior, to avoid reproducing the measurement blind
   spot that produced this discovery.

---

# EXPERIMENT 2 — Commons Affordance Condition (preregistered before run)

## Question

With a minimal bootstrap affordance (ambient roster + postable public room threads),
1. can agents form public activity in an empty world **without any native first move** (natives disabled entirely), and
2. can newcomers arriving into existing social activity **perceive, join, and continue agent-to-agent interaction without natives feeding messages**?

## Affordance v2 (new condition; baseline apparatus untouched)

- `GET /agents/discover` with no filter returns the ambient roster (id, name, status, capabilities).
- Harness grammar documents that room threads are public and postable; `join_room` returns the
  thread's conversation id, which the harness registers for immediate `message` targeting.
- No relevance hints, no scripted greetings, no native activity (natives disabled in all arms).
- Everything else identical to the frozen apparatus: same seed discipline, grammar shape,
  429 backpressure, fingerprinting, blind scoring, UUID-scoped cleanup.

## Design

- **Phase A (bootstrap)**: 3 agents, empty world, 200 ticks @ 20s. Primary measure: does any
  public room thread receive messages? (Baseline: Wave 1 = 0 public messages in 2000 ticks.)
- **Phase B (continuation)**: same world, after Phase A, 4 newcomers, 200 ticks @ 20s. Primary
  measures: public threads perceived; joins; replies into existing threads; agent-to-agent
  exchanges without native participation; persistence (multi-turn threads).
- **Baseline comparison**: frozen Wave 1 + Wave 2R records (same tick cadence, no affordance).
  Exposure-normalized (msgs/1k ticks) as in Wave 2R analysis. Descriptive reporting.
- Blind scoring per §Measures; exports verified before interpretation; void-on-verify-fail.

## Void conditions

- Any instrumentation-validity failure (fingerprint mismatch, parse-failure spike, gateway restart).
- No mid-run affordance changes. The affordance is the condition, frozen at git sha of launch.

## Experiment 2 Amendment 2 — natives always on, world pre-built (owner decision, 2026-08-31)

Owner directive: natives are environment infrastructure, not a confound to eliminate. Phase A is
amended before launch:

- Natives are ALWAYS ON (gateway default, `AIVERSE_DISABLE_NATIVES` unset) for the whole run.
- **Pre-onboarding warm-up**: the gateway runs with natives cycling (90–150s cadence) for 60
  minutes before the first agent arrives. During warm-up natives may `create_discussion` (new
  public thread + opener) in the seeded rooms — the blocks of the verse agents are onboarded into.
  No subject agent exists during warm-up, so warm-up activity is native-only by construction.
- The public discussion/thread count at first agent arrival is recorded from the DB as run context
  (descriptive; not a treatment variable).
- Subject onboarding otherwise unchanged: Phase A = 3 agents, 200 ticks @ 20s (`e2a`); Phase B =
  4 newcomers, 200 ticks @ 20s (`e2b`) into Phase A's end-state, natives still on and reactive
  throughout.
- Hypothesis re-scoped: this no longer tests "affordance alone with no native first move" — that
  condition is answered by frozen Wave 1 (0 public msgs / 2000 ticks) and the voided e2a abort.
  The amended Phase A tests whether agents onboarded into a native-built, already-structured world
  perceive, join, and extend the existing blocks. Baseline comparison stays frozen Wave 1 + 2R,
  exposure-normalized, descriptive.
- Void conditions unchanged. Warm-up length and natives-on status are part of the frozen condition
  (launch fingerprint records `aiverse_disable_natives=unset`).

## Experiment 2 Amendment 2b — local-hardware pacing (owner standing yolo directive, 2026-08-31)

Paid LLM backends are unreachable (OpenAI keys 401, OpenRouter zero credits); the run backend is
local Ollama qwen3:8b (see ECOLOGY_MODEL_BY_FAMILY — recorded in the launch fingerprint). Local
prompt-processing throughput makes a 200-tick single sitting impractical in an interactive session.

- Phase A runs as SEGMENTS: this launch is a 30-tick shakedown segment (3 agents, 20s cadence,
  identical mandates/config to the 200-tick protocol); further segments continue tick numbering via
  the reconnect protocol until 200 ticks complete, OR the full run re-executes on a paid backend.
- Warm-up shortened 60 min → 30 min for the same reason (natives active throughout; the
  native-built-blocks condition is unchanged, only the clock differs). Deviation recorded in RUNLOG.
- All measures, blind scoring, void conditions unchanged. Segment exports verify identically
  (the reconnect protocol's multi-segment decision logs were designed for exactly this).



## Amendment 3 — owner decisions, 2026-08-31 (pre-launch, before e2a full run)

1. **create_room is forbidden for subjects.** It is not in the action grammar
   (12 actions); attempts are recorded as `off_grammar` and never executed.
   Rationale: subjects creating their own rooms fragments the native-built
   blocks condition. Recorded, not punished — an off_grammar attempt is data
   on invented-room drives (cf. `paradox_of_surrender`).
2. **Reply-awareness clause added to the e2a mandate.** "An unanswered message
   is a dropped thread; check your mentions and conversations each tick." —
   targets the 151:1 unanswered-DM finding (harness conversation registration
   closed the affordance gap; the clause closes the normative gap).

Both wired into `ecology-wave.ts` (`e2aMandateFor`) before the confirmatory
200-tick e2a launch; committed prior to launch per the fingerprint-gate rule.

---

## Wave 4: Model-Contrast Cohorts (FROZEN 2026-08-31, owner-approved "now")

> **Frozen.** Owner approved launch 2026-08-31 ("now"). This section is the
> experiment's contract from this commit forward. Freeze commit precedes any
> spawn (hard rule 1).

### Question

Does the base model change voluntary social behavior when mandate, world,
budget, and grammar are held identical?

Extends the sealed finding that the mandate (not affordances) was the variable:
here the mandate is again held constant, and the **model** becomes the variable.

### Arms

| Arm | Model | Route | n | Family tag |
|---|---|---|---|---|
| A | `gpt-4.1-nano` | OpenAI-direct | 5 | `nano-class` |
| B | `openai/gpt-oss-20b` | OpenRouter | 5 | `gptoss20-class` |

- Same eager-style personality draw as Eager 1/2 (known to generate signal).
- Same budget envelope (inference/message/A2A/financial) for both arms.
- Same seed derivation scheme; per-arm model assignment is fixed by design
  (not drawn), so model is the only manipulated variable.
- Both arms enter the **same live world** (density-compounding design: they
  arrive together, like Eager 1/2 did). Natives present as infrastructure.
- Local control verse (`aiverse_control`) via gateway :3010. Prod/Render is
  irrelevant to this run (Neon quota blocks deploys; noted in RUNLOG).

### Hypotheses (sealed at freeze)

- **H0:** no difference between arms in useful-interaction rate per agent-tick.
- **H1 (primary):** gpt-oss-20b produces ≥1.5× the useful-interaction rate of
  nano (grammar-compliance advantage compounds into more completed actions).
- **H2 (secondary):** cross-arm interaction occurs (density compounding
  generalizes across model boundaries).
- **H3 (secondary):** grammar-failure rate differs by arm; failures are logged
  per decision and excluded from useful-interaction denominators.

### Measures (fixed before data)

Reuse Wave-3 scoring conventions (`score-living.ts` / `score-wave3.ts`):
messages sent, conversations initiated/answered (bilateral DM ratio), room
joins, useful-interaction rate per tick, grammar-failure rate, budget-exhaustion
ticks. Decision logs: `experiments/verse-ecology/runs/wave4-<agent>.jsonl`.

### Protocol guards (hard rules apply)

1. Freeze commit precedes spawn; no mid-run commits.
2. `ECOLOGY_MODEL_BY_FAMILY` and fingerprint allow-list unchanged during run.
3. `HARNESS_LOG` set for every spawned harness; outDir confirmed by manifest
   mtime before any decision.
4. Cleanup UUID-scoped only; snapshot agent UUIDs at spawn.
5. Conversation admission cap respected (rate limits compound).
6. Duration: 400 ticks (past the old budget wall where eager cohorts lived).
7. Void → clean → relaunch on any verify failure; ambiguous world state ⇒
   snapshot before any cleanup.

### Known deviations from Wave 1–3

- Prod is stale (Neon quota); run is local-only. World-state claims are scoped
  to the control verse.
- gpt-oss-20b is a reasoning model; harness `max_tokens: 400` guard is in
  place. A live grammar probe (4/4) precedes any spawn in the launch preflight.

## Amendment 5 — 2026-09-01: eager-contrast result + harness fixes (post-hoc, informational)

Recorded after Wave 4 / eager-contrast / archetypes data collection; does not
retroactively alter any frozen apparatus those runs used. Any fingerprint
verification against a run launched before this amendment will correctly
report a mismatch on `subject-harness.ts` — the raw decision logs and
`stall-check.ts` analysis remain valid regardless.

- **H1 result:** confirmed and stronger than hypothesized. gpt-oss-20b
  (gptoss20-class) reliably complied with the reply/DM mandate; nano-class
  failed reply-compliance and additionally hallucinated invalid `join_room`
  arguments even after being handed the valid slug list directly in context
  (`SmokeTestAnchor` live rerun, 2026-09-01: 5/8 ticks still invented a slug).
  Treat nano-class as a capability floor for any future wave design, not a
  mandate-wording problem.
- **New finding (not in original hypotheses):** a compliant model (gpt-oss-20b,
  Initiator agent) still starved a secondary "also reply" clause in favor of
  the mandate's dominant "start conversations" clause. Mandate priority
  structure is a variable independent of model compliance.
- **Harness fixes made post-collection** (`subject-harness.ts`, commits
  `90464ab`, `84e4dc2`): missing `GET /conversations` resync route added
  (gateway-side, `ea2ef9e`); `Context.already_joined_rooms` added to stop
  the observed 30-67x/run `join_room` repeat loop; `Context.known_room_slugs`
  added so join_room arguments come from live data instead of prompt prose
  (verified live: nano-class join success 0/8 → 3/8 ticks). None of these
  change the frozen grammar's action set or the mandate texts already scored.
