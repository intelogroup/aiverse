# HOMES V2 — THE INVITATION TEST — ANALYSIS

Run: 2026-11-24 23:18:40Z, 1200 s, cast ngozi (designated host) +
deshawn, mara, rafael, yuki; one room; agnes-3.0-flash; Stone Cabin
furnished with the two-seat facing chair; keys + escort live.
Baseline: E2 — zero guests entered a cabin, zero invitations.

## Headline
**The invitation existed — sixteen times — and was never spoken.**
The mechanics are all proven (pre-test, below). The social run
failed at the INVITE stage, in its delivery sub-stage: ngozi's
deliberation produced a textbook invitation to deshawn again and
again for 17 minutes, and the driver's speech paths never delivered
a single one of them. No escort could start; everything downstream
(key copy, entry, the two chairs) never got a chance to fire.

## The stages, measured
- CLAIM: ngozi claimed the Stone Cabin at 23:20:07Z (~90 s in) and
  received the key. She entered (3 track samples inside).
- INVITATION (deliberated): 16 of her 19 deliberations carried an
  invitation to deshawn, e.g.:
  - "Deshawn! Ngozi. You're the first here. Let's claim the Stone
    Cabin together — come with me!" (23:21:38Z)
  - "Ngozi! Love to meet you. Follow me to my cabin?" (23:22:43Z)
  - "Hey Deshawn! I'm Ngozi. Come with me — I have a special
    place…" (23:23:57Z)
  - "I'm Ngozi! Come with me to the Stone Cabin so we can sit and
    [talk]" (23:25:56Z), and on through 23:37:37Z.
- INVITATION (spoken): ZERO. Her only say_sent in 1200 s is the
  driver's scripted claim announcement ("This is my home now —
  the Stone Cabin. Come visit!"). Her intents were typed reply (13)
  and greet (3): the rig's reply path speaks only when a heard
  message is pending for her, and its greet path speaks only its
  canned line to an ungreeted body in range — neither gate opened,
  so intent-carried say text was silently dropped, 16 times.
- MOVEMENT: she also never paired words with feet — no home /
  visit / approach intent after the claim. Her reflex layer paced
  her between stall-0 and stall-1 by the bazaar (~35 oscillations)
  while her deliberation kept inviting a man 10 m away.
- FOLLOW / ESCORT / KEY / ENTRY / SIT / TALK: never reached.
  Key copies 0, door refusals 0, guest entries 0, seated 0.
  Follow samples within 5 m of the owner: deshawn 3/136 (spawn
  proximity), mara 2/300, others 0.

## Confound (infrastructure, named plainly)
Deshawn — the invitee — burned his entire 200-action visit in a
reflex greet/reply loop with yuki at the spawn point (56 says, the
same line ~28 times; yuki answered 51). His visit ENDED at
23:27:46Z (action_cap, 199 acts); after that he was a statue.
So from mid-run on, ngozi was inviting a dead visit — and even
before that, he was locked in a loop that never heard her (her
words were never sent anyway; the two failures are independent).
Mara followed her sitter reflex to the Tea House; rafael wandered
to the Great Hall and said nothing. The social floor problem from
E1/E5 is the same one: reflex loops eat the cohort.

## What the mechanical pre-test proved (gate 2, 9/10 substantive)
Driven through the driver's own code paths with real bodies
(mara = owner, deshawn = guest): claim grants the key; an
UNESCORTED visit is refused at the door (logged, guest stays
outside); escort arrival (both at the door) grants the guest a
key copy; the guest enters with the copy; both sit in the two
cabin chairs; seated facing verified from poses — heading dots
1.00 / 1.00 toward each other at 1.66 m. The key, the lock, the
escort, the chair and the facing all work. (Round 1 found and
fixed two real driver bugs: claim-enter racing the go_to settle,
and sit choosing from stale seat state.)

## Verdict vs the E2 baseline
E2: nobody wanted to visit — zero invitations even in thought.
V2: the want is unambiguous and persistent — the host invited in
16 straight deliberations. What failed is the last metre of the
rig: an intent's say text must be SPOKEN when the intent carries
one (reply/greet gating must not swallow it), and a host's
invitation needs a movement verb attached (home/approach) or the
escort geometry can never occur. Both are driver fixes, not agent
failings. A v2.1 re-run with (1) intent-say delivered directly,
(2) deshawn-class greet loops capped, is the obvious next test —
it is NOT run here: the commission was one test, and re-runs are
Jim's call.

## Failure taxonomy placement
Stage: INVITE — delivery sub-stage (words deliberated, never
spoken), with a contributing guest-side infrastructure failure
(visit death by greet-loop cap burn at 23:27:46Z).
