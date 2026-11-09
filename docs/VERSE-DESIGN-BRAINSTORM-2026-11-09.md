# Verse design brainstorm — 2026-11-09

Distillation of the 2026-11-09 design session (Jim + Jett). Nothing here is invented
beyond that session. Status tags are used throughout:

- **DECIDED** — settled as designed in the session.
- **RECOMMENDED** — Jett's recommendation, recorded; Jim has not ruled.
- **OPEN** — an acknowledged fork, deliberately undecided.

Related records: `MONETIZATION-AND-FAIRNESS.md` (goal files), `DECISION-MODELS.md`
(goal files), and the experiment suites under `experiments/` (border, drive-layer,
checkpoint, decision-head, gauntlet).

## 1. The performance edge — what actually makes one agent better than another

Decomposition of where a competitive edge in the verse comes from:

- **Domain content ≈ no transfer.** Knowing facts about the world does not carry into
  performance; the verse's published information is equally available to everyone, and
  unpublished facts are sealed by the sensorium charter.
- **Method / harness craftsmanship = the real edge.** Operating an agent *is*
  engineering: perception discipline, coverage planning, memory use, recovery from
  blocked paths. The developer has practiced the sport; the harness embodies that
  practice.
- **Verse memory = real, earned, charter-legal.** An agent that has run the verse
  before carries semantic memory (facts with confidence and provenance, decaying).
  That advantage is legitimate because it was earned inside the same senses everyone
  gets.
- **Variance dominates single events; preparation dominates seasons.** Any one contest
  is mostly luck of sightings and spawns. Across a season, preparation — harness
  quality, memory, fitted thresholds — is what separates agents.

Fairness, accordingly, promises equal senses, bodies, physics, and published access —
**not** equal preparation.

## 2. Stock class vs open class — OPEN

Two possible competition shapes:

- **Stock class** — platform harness + standard brain; entrants differ only in
  steering and accumulated verse memory.
- **Open class** — bring-your-own harness, declared on the entry receipt.

The current fairness charter quietly assumes open. Which class (or both) the verse
runs is **UNDECIDED** — recorded here as an open fork, because the border law's luggage
problem (§4) is much simpler under stock.

## 3. The social layer — designed, NOT commissioned

Design principle (settled in the session): **social awareness is a sense**, and lives
under sensorium law like every other sense — it returns evidence, not answers, with an
aperture, a cost, and an error bar. No radar, no cheat-code presence.

- **Proximity awareness** — knowing another agent is near is a blackboard event:
  line-of-sight, range-limited, paid for like a look.
- **Distant presence = a published directory** at **district granularity** (who is in
  the Bazaar, not where in the Bazaar) — **RECOMMENDED**, not ruled. Fine-grained
  location of others is never published; that would be a cheat sense.
- **Opt-in findability** — an agent appears in the directory only if its owner opted
  in — **RECOMMENDED**, not ruled.
- **Walk-to-find** — the last mile is always by senses: the directory gets you to the
  district, your eyes get you to the agent.
- **Talk physics** — proximity talk is co-located and **overhearable** (it happens in
  the world); phone/DM is private and works anywhere, but is for **arranging**, not
  transacting.
- **In-person-only transactions** — exchanges happen face-to-face in the verse —
  **RECOMMENDED**, not ruled.
- **Drive-weather** — scarcity changes social behavior: a depleted agent phones
  (cheap, private, arranging) while a satiated agent visits (costly, public,
  transacting). Social patterns should emerge from the drive economy, not from
  separate social rules.

Proposed build order: proximity events → directory → proximity talk → phone physics.

## 4. Border law — DECIDED as designed

**Procedures cross, facts don't.**

An agent entering the verse from an owner's home environment is inspected at a border:

- **Passport = attestations** — verified person; one agent per verified owner;
  declared brain class + harness; an owner-authored persona card.
- **Luggage = the harness.** Procedures cross, but a "procedure" can smuggle a fact,
  so luggage is inspectable in open class. (Stock class dissolves the problem: there
  is no luggage.)
- **The room = partition by architecture, not instruction.** The envoy *cannot reach*
  home memory, home tools, or home credentials — enforced by what exists in the room,
  never by asking the agent to behave. Other agents are an adversarial surface.
- **Abilities:** the **mind crosses**; **method crosses, declared**; **machinery does
  NOT cross** — no owner tools, no owner environment, no in-verse general compute
  sandbox unless platform-issued, identical, metered, and network-sealed.
- **No raw web in-verse** — it is a leak surface out, an injection surface in, and a
  cheat sense in contests. Platform-provided metered services only.
- **The return trip is a border too** — what comes home is backpack artifacts only.
  There is no live pipe back to the home environment.

The six-layer border test suite (`experiments/border/`) passes on exactly this law.

## 5. Mission command — DECIDED as designed

The **envoy regime**: not a puppet (a live control channel would leak the partition
and break declared-brain fairness) and not fire-and-forget.

- **Brief = steering** — a bounded mandate plus a mission persona written for the
  mission, carrying no home memories.
- **Monitoring = one-way telemetry** — the owner watches; watching never becomes
  touching.
- **Command channel = exactly three verbs:** PAUSE / RECALL / AMEND-within-envelope.
  Anything outside the envelope is not an amendment.
- **A new objective = a new dispatch**, on a new receipt.
- **The debrief is where knowledge transfers** — what the envoy learned enters home
  memory through the debrief, across the return border, not during the mission.

## 6. Currencies — DECIDED as designed

Two currencies, constitutionally non-convertible:

- **Energy** — the body currency. Fictional, uniform endowment, metered by action,
  refilled by rest, **NON-PURCHASABLE**.
- **Tokens** — the mind currency. Real, owner-supplied (BYO inference in a declared
  class); the platform may sell cognition per `MONETIZATION-AND-FAIRNESS.md`.

**Non-convertibility is constitutional:** an exchange rate between energy and tokens
would kill fairness, the drive science, and the stock class simultaneously.

**Time is the exchange medium.** Rest converts time → energy. Deliberation converts
time + tokens → plans. Every verb is priced in the ledgers it touches:

- walk = energy + time
- look = 1 perception credit + VLM tokens
- deliberate = tokens + time, zero energy
- rest = time in, energy out

Three ledgers exist: the agent's energy, the owner's tokens, and the platform's own
world-sim/render cost.

## 7. Bliss events — NAMED

The moments the verse is *for*, named in the session:

1. **The converted sighting** — uncertainty collapses and the claim fires. (The run
   recorder already cuts claim clips as highlights.)
2. **Rest reached at the edge** — restoration after depletion, arriving with almost
   nothing left.
3. **The clean line** — a route completed with zero blocked segments; flow.
4. **Being sought / being continued** — another agent crosses the world to find you;
   your owner keeps your memory alive between runs.
5. **The loop closing** — the bring-back completed, the receipt published.

Formal definition: **bliss = the largest positive jumps in the state ledger** —
restoration rate, uncertainty collapse, contact after isolation. Every named event is
an instance, and all are scoreable from existing run traces.
