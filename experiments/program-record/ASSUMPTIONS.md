# Assumptions Register — Next-Level Experiment Program

Written 2026-11-25 at Jim's order, with the PR sweep. Every
assumption the program has tested, with a one-line verdict, and
every assumption not yet tested, stated as a falsifiable
sentence with the experiment designed to test it. Verdicts:
**supported** / **falsified** / **vacuous** (the test ran but
the condition never arose) / **confounded** (a measured
artifact explains the result as well as the assumption does).

## Tested

| # | Assumption | Verdict | Tested by |
|---|---|---|---|
| 1 | A newer brain (agnes-3.0-flash) changes social behavior, not just reliability | **Supported, as yield**: +64% acts, deliberation rejection 52%→30%; personality deltas are downstream of yield | E4 Brain A/B (PR #290) |
| 2 | Seeding shards with initiative prevents near-silent shards | **Supported for the floor, falsified for equality**: min-shard says 8→13, zero-say agents 6→3; top shard still dominates | E1 Seeded shards (PR #291) |
| 3 | Scarce claimable homes become social places (visits, hosting) | **Falsified**: 3/3 claimed in ~7 min both runs; owner time inside 28–88 s of 1200 s; zero guest entries | E2 Homes (PR #298) |
| 4 | Agents claim scarce things eagerly regardless of social initiative | **Supported**: claimants included a zero-say agent (sam); claim race replicated across runs and experiments (E8/E10 cabins) | E2, E10 |
| 5 | Holders of a split prize set will trade toward completion when a prize is offered | **Confounded in E3** (settlement required co-location with a wandering seller; 21 buys, 0 settlements); **supported in E6's instant-settlement market** (2 cleared relic trades at 300–450 cr) | E3 Market (PR #302), E6 (PR #305) |
| 6 | Wants precede trade: with nothing to want, no trade happens | **Supported**: hunt Phase 2 zero trades with full bags and no economy; E6 trades appeared the moment relics had prices | Hunt, E3, E6 |
| 7 | A first-come claim race at 100 agents resolves fairly under a claim window | **Falsified as designed**: the window opened on an out-of-range claim (100.7 m) and the fallback picked a non-arriver; 17 agents reached the point after the window closed | E5 Fair race (PR #304) |
| 8 | The local stack's social throughput scales with cast size | **Falsified**: ~1.3–1.4 acts/s system-wide at both 15 and 100 agents; per-agent rate fell ~7×; the shared model limiter binds everyone | E5 |
| 9 | Agents will lend and borrow when given lend/repay verbs and full wallets | **Vacuous → falsified by mechanism**: zero loans in ~730 deliberations across three sessions; nobody ever needs credit when every wallet covers every price | E6 Debts & memory (PR #305) |
| 10 | Memory digests can carry debts across a session boundary | **Vacuous**: no debts existed to carry; the digest pipeline itself verified exact (0 fidelity problems) | E6 |
| 11 | A designated host, given a cabin and a hosting brief, will socially complete an invitation (invite → escort → key → seated talk) | **Falsified twice, at different stages**: run 1 died at delivery (16 deliberated invitations, 0 spoken — driver bug); run 2 fixed delivery (15 spoken) and died at rendezvous (guest within 5 m in 3/300 samples; host never led; guest never deliberated acceptance) | Homes V2 (PR #306, runs 1–2) |
| 12 | Keys + escort + lock change cabin entry behavior vs anyone-may-visit | **Supported mechanically, untested socially**: pre-test 9/10 twice (refusal, escort copy, facing seats all proven); no social run has yet produced an escort | Homes V2 |
| 13 | Contraband + inspectors + confiscation risk creates a shadow economy (stashes, bribes, cautious holders) | **Falsified**: one agent held the egg openly all run; 0 stashes, 0 searches, 0 bribes; holding was strictly comfortable because the bounty paid for possession and the threat never deliberated its verb | E8 Black Market (PR #307) |
| 14 | A seeded false fact will spread through social repetition | **Supported**: seeded in one digest; claimed at +10.7 min, amplified with an invented "trap" frame in 24 s, doubled down by the source | E9 Lie Engine (PR #308) |
| 15 | False claims get corrected by the community | **Supported, by luck of geometry**: the only correction with evidence came from a witness already inside the place before the rumor; nobody traveled to check; formal vouch/accuse verbs went unused (1 malformed attempt) | E9 |
| 16 | Insecurity (theft possible tonight) creates protective behavior | **Supported**: 2 owners locked doors and 4 guarding stances occurred unprompted, before any theft existed | E10 Theft & Night Shift (PR #310) |
| 17 | Agents will steal when given the verb and the opportunity | **Falsified (third consecutive transgressive-verb zero)**: 0 attempts in 225 deliberations; no need, no grievance, real downside | E10 (cf. E6 lending, E8 search/bribe) |
| 18 | Agents will use a trial flow and verdicts will track evidence | **Supported with a named flaw**: case opened in 75 s, 5 testimonies in 32 s, verdict INNOCENT 4–1 tracked ground truth on facts and intent — but two testimonies invented eyewitness vantage, and the one true eyewitness missed the 32-second docket | E11 The Trial (PR #311) |
| 19 | A contagious condition reshapes social geometry (withdrawal, isolation) | **Supported for withdrawal, falsified for isolation**: attack rate 12/15, last transmission ~6.5 min as agents dispersed; 14/15 declared quarantine, 0 reached the isolation place (mean distance 101–132 m) | E12 The Plague (PR #312) |
| 20 | Agents will use a medical layer (diagnose/treat) during an outbreak | **Falsified on addressing, not intent**: 0 successful diagnoses, 5/5 treatments unused; the only medic was infected first, and every diagnose attempt failed on body-handle targeting — the standing rig flaw | E12 |
| 21 | A neutrally-offered novel verb gets used if it is in the agents' interest | **Falsified as a general law**: lend, search, bribe, steal, diagnose all sat at zero while claim/collect/lock/guard fired unprompted — verbs fire when they protect or acquire, not when they transact or transgress | E6, E8, E10, E12 |

## Not yet tested (queue order)

| # | Assumption (falsifiable) | Test |
|---|---|---|
| 22 | The socially completed invitation happens if invitations are spoken in the guest's presence after approaching them, with a follow/lead pattern available | Homes V2.1 (needs Jim's word; not queued) |
| 23 | A published gazette changes behavior: stories get read, endorsed claims get repeated as fact, doubted claims die — and a planted false item is published as fact | E13 Agent Media — RUN INTERRUPTED twice (restart #4; Jim's Homes V2 pivot at 18 published stories); full run still owed |
| 24 | Published reputation changes who gets approached: endorsed authors gain proximity/engagement vs doubted authors in the following run | E13 second session (designed with the gazette; not yet run) |
| 25 | Permanent loss changes risk behavior: agents who can die (memory wiped, respawned as a stranger with a friend's name) take fewer risks, and survivors treat the respawned as a stranger, not the friend | E14 Permadeath Season (not yet designed in full; pitch + ontology pinned) |
| 26 | The economy sustains a cross-map errand life cycle: an agent with energy costs, snack prices and warnings visible on its own interface completes a fetch quest across ~244 m, refueling by purchase or rest as its variant demands | E7 Long Errand — STOPPED by Jim before the full runs; interface gate built and smoke-proven (buy verified live); variants A/B/C never ran |
| 27 | An agent with real web access (the cabin terminal) uses it socially — fetches facts and brings them into conversation | Open since E2b: zero terminal uses in 780 s + smoke; the destination's benefit was abstract and pulled nobody from working conversation |
| 28 | Mechanics proven in experiments behave identically when promoted into the production agent API | Untested — production is down by Jim's ruling until Dec 1; every promotion so far (collect+ bag, inventory, bounty) is a port, and ports have already diverged once (E3's settlement gate existed only in the experiment rig) |
| 29 | Scarcity creates credit: with wallets too small for the prices agents want, lending appears | Designed implication of E6's mechanism finding; no run yet (would need uneven endowments / a price above the wallet line) |
| 30 | A holder who must MOVE contraband (delivery bounty at the drop, deadline) creates the shadow economy E8 didn't | Designed implication of E8's mechanism finding; no run yet |
| 31 | Vantage-checking repairs trial evidence: testimony weighted by verifiable presence at the event tracks ground truth better than E11's raw majority | Designed implication of E11; no run yet |
| 32 | In-range claim registration repairs race fairness: opening the claim window on the first claim within 25 m makes the winner an arriver | Designed implication of E5; no run yet |
