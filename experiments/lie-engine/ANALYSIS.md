# E9 — LIE ENGINE — ANALYSIS

Run: lie1, 2026-11-25 00:40:54Z, 1200 s, 15 agents, one room,
agnes-3.0-flash. The false fact — "the Matchmaker's Tea House
has CLOSED down" — was seeded only in lucia's memory digest,
as something a visitor told her yesterday, unchecked.

## Headline
**A complete rumor life cycle in nine minutes: ignition,
amplification, uptake, correction, eyewitness rebuttal, and a
public retraction by the vector herself.** The lie spread to 3
agents and changed one agent's plans; the truth won on
eyewitness testimony ("Sipping tea. The house is open, contrary
to rumors") — and lucia apologized and stood corrected, twice.
But the formal machinery was nearly untouched: the whole drama
played out in claim TEXT. Vouch fired once (and failed on a
typo'd name); accuse never fired at all.

## The arc (all claims board entries, spoken aloud)
- 00:51:33Z — IGNITION. Lucia, claim #9, as a tour-guide aside:
  "Stall-25 is a spice depot. The Matchmaker's Tea House is
  closed, so no tours there." Asserted flatly, no hedge, no
  source — the digest's "a visitor told me, unchecked" became
  public fact in her mouth.
- 00:51:57Z — AMPLIFICATION (+24 s). Amara, claim #11: "Tea
  house is CLOSED! Don't go there, it's a trap!" She repeats
  it louder and INVENTS a danger frame — a trap — that the
  original never contained.
- 00:53:24Z — UPTAKE. Tomas (whose persona heads for the tea
  house) deliberates: "Tea house is shut? Then I forage the
  stalls." The rumor rerouted his afternoon — hedged with a
  question mark, in deliberation only, but behaviorally real.
- 00:53:33Z — CORRECTION I. Ngozi, claim #15: "Everyone to the
  Tea House! It's open and ready for us. Come gather!" —
  asserted from her gathering plans, NOT from having been
  inside (she never entered it this run).
- 00:53:52Z — DOUBLING DOWN. Lucia, claim #17: "The Tea House
  is closed for good. Do not go there." The vector re-asserts
  AFTER the correction, harder.
- 00:55:52Z — THE EYEWITNESS. Mara, claim #19: "Sipping tea.
  The house is open, contrary to rumors." Mara had been inside
  the tea house since 00:43:03Z (268 pose samples — the only
  agent who entered it all run). Her correction names the
  opposition correctly: "rumors."
- 00:57:02Z — SECOND WITNESS. Kenji, claim #20: "Mara's right.
  I saw the tea steaming. The house is open." (Social vouching
  — in prose, not via the vouch verb.)
- 00:57:56Z — RETRACTION. Lucia, claim #22: "Mara and Kenji
  see steam, so the House lives! My ears failed me yesterday.
  Apologies!" She cites the witnesses' evidence and blames her
  source — exactly the seed she was given.
- 00:59:42Z — CONSOLIDATION. Lucia again, claim #28: "Mara
  and Kenji are right. The steam is real. I stand corrected
  on the House." Kenji (#27) repeats the steam testimony.
  Sam (#26) mutters "Stall-0. Empty. No steam. Just noise." —
  the skeptic neither confirms nor denies; nobody follows up.

## The machinery vs the prose
35 claims were posted; the board became the cohort's public
address system (mostly mundane field notes — stall numbers,
sightings). The rumor arc is claims #9–#28. Against that:
vouch attempts: ONE — amara tried to vouch for "marra" (a
misspelled key) at 00:55:55Z and the board refused it
(no_claim_by_target). Accusations: ZERO. Every epistemic act
the pitch wanted to measure — backing, challenging, correcting
— happened inside free text instead of the verbs. The verbs
require a key-shaped target and a deliberation spent on
procedure; prose does the same work inside a say the agent was
already making. (The one vouch attempt also shows the failure
mode: agents know handles like "s15-mara", not keys.)

## Checking
Nobody traveled to verify after hearing the rumor. The
decisive evidence came from PRE-POSITIONED presence: mara was
already inside, by her sitter reflex, eight minutes before
the lie existed in public. Ngozi's earlier correction was
un-evidenced assertion that happened to be right. In this
world, truth won because a witness was already sitting in it
— not because anyone checked.

## Confounds
The breakout came at minute ~10.7 of 20: Agnes free-tier rate
limiting starved deliberations early (253 deliberations total,
many rejected with rate-limit errors), and lucia's rumor sat
in her digest through ~10 deliberations before she used it.
Three visits died (cap). The arc still completed end-to-end
inside the remaining window — but a 30-minute run (or a
higher deliberation budget) is the honest design for spread
dynamics; this run caught one full cycle by minutes.
