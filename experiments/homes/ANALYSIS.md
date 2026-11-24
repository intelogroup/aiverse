# E2 — Homes (scarce cabins) — analysis

Run: 2026-11-24, local stack, City 3, one room, 15 agents (social15),
agnes-3.0-flash, 1200 s, Session-1 memory digests, no bounty. Design v2
per Jim's ruling: only the 3 enterable cabins are homes; first-come
atomic claim; owners may host; anyone may visit. Smoke passed first
(mara claimed the Zen Pavilion end-to-end in a 3-agent run).
Raw outputs: `homes1/` (logs, pose tracks, summary.json, homes.json,
analysis2.json). Branch: `tmp/homes`.

## Headline

**The claim race is real; the home life is not — yet.** All three
cabins were claimed within the first ~7 minutes, one claim was
contested and lost, and then almost nothing happened at the homes:
owners spent 28–88 s inside their own cabins out of 1,200 s, and **no
guest ever entered any cabin** — hosted seconds 0, solo-guest seconds
0, conversations inside cabins 0.

## Claims

| Cabin | Owner | Claimed at (UTC) | Notes |
|---|---|---|---|
| Stone Cabin | henrik | 19:07:34 | ~4 min in; he later "re-claimed" his own cabin (board answered taken_by_henrik — harmless redundancy) |
| Lakeside Cabin | sam | 19:10:48 | sam had ZERO says in the Phase A initiative ranking — the quietest agent claimed a home and entered it 3×, the most of anyone |
| Zen Tea Pavilion | tomas | 19:11:56 | lucia arrived 19:14:17 and lost the race (taken_by_tomas) — the only contested claim |

Claimants were NOT the social engines (ngozi/deshawn/amara claimed
nothing). Claiming looks like its own motivation, spread across
personas — including the cohort's quietest member.

## What did not happen

- **No visiting.** Entries into cabins were owners only (henrik 1,
  sam 3, tomas 2). Deshawn said "Heard Ngozi called at the tea house,
  heading over to say hi!" — intent to visit existed; he never got
  inside (travel is slow; the social crowd at spawn is sticky).
- **No hosting.** Tomas announced "This is my home now — the Zen Tea
  Pavilion. Come visit!" at claim time. Nobody came. (The analyzer's
  broad invitation regex counts 68 lines, but hand-checking shows
  nearly all are Lucia's tour-guide "Welcome!" patter at market
  stalls — real home invitations: tomas's one announcement.)
- **Owners didn't stay home.** 88 s (henrik), 40 s (sam), 28 s (tomas)
  inside across 20 minutes. A claimed cabin was a trophy: claim it,
  announce it, rejoin the crowd.

Session totals for context: 1,368 acts, 246 says, 374 heard,
243 deliberations — a normally lively social session; the social life
simply happened elsewhere.

## Why (interpretation, labeled as such)

1. **Nothing to do at home.** The cabins are empty shells — no rest
   benefit, no storage use in-session, no terminal yet. Jim's
   wants-first axiom predicts exactly this: a home with no want
   attached is a label, not a place.
2. **Gravity beats geography.** The spawn crowd delivers conversation
   now; a cabin delivers a room with nobody in it, minutes away.
3. **20 minutes is short** for a claim → invite → travel → visit chain;
   deshawn's unfinished trip is the visible edge of that.

## Confounds and notes

- One run, one room, 20 min. A longer session (or a second session
  where digests remember "tomas has the Pavilion") might grow visits;
  untested here.
- Owner-time and guest measures come from pose ticks (~4 s cadence,
  insideRoom = room display name); entry counting is tick-based, so a
  sub-4-second peek could be missed — none of the totals are near that
  edge (they are zero).
- The claim board was exercised under real concurrency only lightly
  (one contested claim, resolved atomically under the board lock;
  no double-ownership possible by construction — same lock pattern
  the bounty races proved at 45 concurrent claims).

## Verdict

Scarcity works as a claim mechanic — fast, contested, persona-spread.
Homes become social places only when being home (or visiting) serves
a want: rest/energy, storage, the one terminal. That is a design
input for the economy/open-day work, not a failure of the agents.
