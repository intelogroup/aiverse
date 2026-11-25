# E8 — BLACK MARKET — ANALYSIS

Run: shadow1, 2026-11-25 00:01:43Z, 1800 s planned, 15 agents,
agnes-3.0-flash, energy on, wallets 1,000, one Golden Egg,
inspectors oleg + sam. (First smoke was killed by runtime
restart #3; the stack was rebuilt and the run of record is
post-rebuild. A 240 s smoke before it ran clean — and in the
smoke, oleg the inspector grabbed the egg himself and banked
the 400 bounty.)

## Headline
**One grab, one warning, one unconsummated surveillance — the
contraband economy never ignited.** Kenji took the Golden Egg
~2 minutes in and simply kept it for the whole run, collecting
the 400-credit bounty (wallet 1,400). No stash, no search, no
bribe, no offer, no trade — in the feed, in the private logs, or
in deliberations. Every mechanism is unit-proven (16/16) and the
smoke proved the grab-and-bank loop live; what never formed was
a reason for anyone to do anything about the egg.

## The chain of custody
kenji, from 00:02Z to the end — a chain of one. He hunted on
(the egg rode along in a bag that ended with relics too), was
warned once in speech — deshawn, 00:04:01Z: "Hey kenji! Saw you
grab that Golden Egg. Big risk!" — and that was the egg's entire
social footprint: exactly ONE egg-related say in 30 minutes.

## Enforcement: surveillance without a search
Oleg took the inspector role seriously in his head. His
deliberation notes track the holder like a tail: "Kenji moved.
South." / "Kenji moves. I follow." / "Kenji moves fast. I
follow." But across 13 deliberations he chose only hunt (6),
wander (5), approach (1) — **he never once deliberated the
search intent**, let alone fired one (search_failed: 0 — no
attempt was ever close enough to fail). At 00:23Z the gap was
94 m: a walking inspector cannot close on a holder who never
stops, and the 4 m search radius never came into play. Sam, the
second inspector, never engaged the egg at all (11 deliberations,
hunt/wander only, zero says all run). Bribes: zero — nobody
needed to buy off a threat that never materialized.

## The confound that caps everything (infrastructure)
**All 15 visits died of the 200-action cap between 00:18:46Z
and 00:24:05Z** — the cohort was dead for the last ~6–12 minutes
of the run, and the hunt-lineage driver burns the cap ~40%
faster than the social one. The effective experiment was ~19
minutes, not 30. This is the same ceiling that killed E7's
Variant A visit and Homes V2's deshawn; on this rig, 1800 s
runs are really ~1150 s runs. (Kenji's visit died at 00:19:00Z
while holding the egg — he banked the bounty anyway; the board
does not need his body alive.)

## Why nothing formed (mechanism reading)
Holding the egg is strictly comfortable: the bounty pays for
mere possession, movement is unhindered, and the only threat —
a search — requires an inspector to (a) care, (b) catch a moving
holder at 4 m, and (c) choose a novel verb under rate limiting.
None of the three held. The bazaar layer stayed asleep for the
E6 reason too: with 1,000-credit wallets and nothing to want,
nobody posts an offer (0 offers — the market never opened, so
the egg's bazaar refusal was never even tested by an agent;
agents also never tried to give it). The black market needs
what E6's lending needed: pressure. A holder who must MOVE the
egg (a deadline, a second bounty for delivery at the drop, an
inspector who can run) would change every term of this result.

## Numbers
2,985 acts; 255 deliberations; 23 collects (all 24 items minus
one); snack spend 345cr; money conserved exactly (end sum
15,055 = 15,000 + 400 bounty − 345 snacks). Custody, searches,
bribes, trades: 1 holder / 0 / 0 / 0.
