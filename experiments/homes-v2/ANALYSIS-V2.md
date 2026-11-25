# Homes V2 — The Invitation Test, RE-RUN (homesv2b, 2026-11-25)

Run 2 of the Invitation Test, ordered by Jim 2026-11-24 22:03 ET
("Yes now") after run 1 (ANALYSIS.md) failed at the INVITE stage:
the host deliberated an invitation 16 times and the driver
silently dropped every one. Same rig, same cast (ngozi host +
deshawn, mara, rafael, yuki), same Stone Cabin with the two-seat
facing chair, 1200 s, agnes-3.0-flash — with two fixes and one
ruling applied.

## The fixes, and their proof

**FIX 1 — speech delivery (the run-1 blocker).** A new
`_speech_step` runs before the homes/policy steps in the actor
loop: when a fresh deliberation carries say text, the text is
spoken through the normal say path (logged
`intent_speech_delivered`), unless an addressed reply is pending
(that path delivers it properly) or the intent is a claim (the
homes step speaks its own announcement). Proven in the 300 s
smoke before the run: 7 speech deliveries, including two spoken
cabin invitations.

**FIX 2a — reflex-loop suppression.** `reply_pending` never
repeats the same line to the same partner within 180 s (logged
`reply_repeat_suppressed`); the re-greet window rose 90 s →
300 s. Smoke: deshawn said 7 lines total (run 1 pace: 56), max
repeat 2×, suppressor fired once.

**FIX 2b — no visit action cap (Jim's Nov 24 ruling).** The
local gateway's starter cap constant and the rotation script
were set to 100,000 for this test (`rotate_local_nocap.py`).
Proof in the run itself: deshawn took **283 actions** and
rafael **201** — both beyond the old 200 cap — and **zero
visits died** (run 1 lost the invitee mid-run to the cap).

Mechanical pre-test re-run after the patches: 9/10, identical
to run 1's round 2 (the one "FAIL" line is the known script
artifact — the detail shows both agents seated in the two cabin
chairs, facing dots 1.00/1.00 at 1.66 m).

## Staged measures, run 2 vs run 1

| Stage | Run 1 | Run 2 |
|---|---|---|
| Claim | ngozi, ~90 s | ngozi, **03:18:02Z (~88 s)** |
| Invitations SPOKEN | **0** (16 deliberated, all dropped) | **15** (see below) |
| Acceptance (guest deliberates it) | 0 | **0** |
| Follow / rendezvous | n/a | deshawn within 5 m of ngozi in **3/300** pose samples |
| Locked-door refusal | 0 | 0 (guest never approached) |
| Key copies | 0 | 0 |
| Guest entries | 0 | 0 |
| Both seated / facing | 0 / — | 0 / — |
| Seated talk | 0 | 0 |
| Visit deaths | 1 (invitee, cap) | **0** |

The 15 spoken invitations grew more specific over the run —
early ones generic ("Come with me, I've found a lovely spot"),
later ones naming the furniture and the offer to lead:

- "Hi Deshawn! I'm Ngozi. Come over to my Stone Cabin, let's
  chat in those two seats!"
- "Deshawn! Ngozi here. Come with me - let's sit in my Stone
  Cabin."
- "Hi Deshawn! I'm Ngozi, organizer here. I've just claimed the
  Stone Cabin as my home! Want to come over? It's far north,
  but I'll lead you."

## Where the chain breaks now: RENDEZVOUS

Run 1 died at INVITE (delivery). That stage is fixed — and the
failure it was masking is now cleanly visible one stage down:

1. **The invitations were mostly spoken where the guest could
   not hear them.** Speech in this world is proximity-bound.
   Ngozi and deshawn were within 5 m of each other in 3 of 300
   pose samples. She invited an absent man, repeatedly, from
   the spawn crowd.
2. **The host never paired words with travel.** Ngozi's 18
   deliberations: claim ×2, greet ×6, reply ×9, home ×1 — and
   her track holds **zero samples inside the Stone Cabin**
   after claiming it. She announced, invited, and stayed in
   the crowd, oscillating socially like run 1. "I'll lead you"
   was said; leading was never deliberated as movement.
3. **The guest never took it up.** Deshawn's deliberations
   contain zero mentions of the cabin or the invitation. His
   44 says were spawn-crowd socializing (including a running
   conversation with a companion he called "Ingird" — a
   misremembered name from his digest; no such agent was in
   the cast). Whether he ever heard an invitation is doubtful
   on the geometry alone.

There is still no follow/lead verb — a guest must independently
`go_to` the same destination — but run 2 shows the binding
constraint is earlier than the verb: **rendezvous**. An
invitation protocol in a proximity-speech world needs the host
to first GO TO the guest, speak in range, and then move — a
choreography neither agent's deliberation produced even once
in 20 minutes, despite the host's brief, the claim, and fifteen
increasingly explicit invitations.

## Honest confounds

- The speech step speaks from wherever the agent stands; a
  greet intent's walk-to-body may land after the words. The
  fix guarantees delivery, not delivery *in range*.
- FIX 2a is a window, not a cure: deshawn repeated one line
  3× at >180 s spacing (a slow echo, not the run-1 death
  loop). His total volume (44 says) was social, not stuck.
- 5-agent cast, one host, one designated invitee in her
  brief's orbit — deshawn is also simply the cohort's most
  distractible socializer (E1 initiative data: high volume,
  low follow-through).

## Verdict

The Invitation Test's question — *can the socially completed
invitation happen at all?* — is now answered in two parts.
The **want** is real and the **words** now land (0 → 15).
The **choreography** does not exist: no approach, no in-range
ask, no lead, no follow. Baseline for any v2.1: invitations
spoken in the guest's presence after approaching them, and a
follow verb (or a deliberation pattern that pairs "come with
me" with the host's own go_to of the cabin) — the machinery
underneath (claim, lock, escort key copy, facing seats) is
proven and waiting, exactly as it was after run 1.
