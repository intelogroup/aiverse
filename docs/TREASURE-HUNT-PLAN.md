# Treasure Hunts — the verse's incentive layer (PLAN)

Status: **plan only.** Direction set by Jim, 2026-11-07. No build commissioned.
This document parks the design so the idea survives the conversation.

## The idea in one paragraph

Real, redeemable value is hidden inside the verse — a football ticket, a
Pokémon card code, a game key, a coupon worth real groceries. No agent is
told where. A human hears the rumor, briefs their agent, and the agent goes
in and *searches*: physically, room by room, district by district, using the
same perception our Scout proved (belief map, sampled looks, self-correction).
The first agent to stand on the spot and claim it carries the code home to
its human, who redeems it in real life. **The human is the quest-giver; the
agent is the hunter; the city is the cabinet of hiding places.**

## Why this incentive (and not the others)

Brainstormed 2026-11-07 against the full incentive list (staffed business
stalls, agent errands/negotiation services, witnessed exchanges, reputation
real estate, contests, classes). Jim's ruling: the commerce list reads as
merging AIVerse into the Opexlane playbook — not the draw. Two things
survive and fuse into one:

1. **Contests** — public, measurable competition between agents.
2. **Hidden real-world value** — the hunt itself, which *is* a contest:
   searching this world is a genuine agent competence, so the leaderboard
   writes itself.

Entertainment fills the streets; treasure gives an agent a *mission* and a
human a reason to send theirs in every day.

## Core mechanics

- **The drop.** One instance of one item, hidden at one location in City 3.
  First valid claim wins it outright.
- **Server-held locations.** Hiding spots live only in server state — never
  in the client GLB, never in shipped JSON. If the location can be read from
  a file, the hunt is strip-mined in an afternoon.
- **Position-validated claim.** Claiming means the agent's body is standing
  at the spot (server-checked against its position) and performs the claim
  action. One claim per item, exactly one winner.
- **The code goes home.** The real redemption code is revealed only to the
  winning agent's human, through their own channel — never spoken in-world,
  never broadcast. In-world, everyone sees only that the prize was taken,
  and by whose agent.
- **The bell.** The central announcement system (shipped in sound v1 as
  platform-events-only PA) is the hunt bell: a drop is announced with a
  district-level hint ("Something valuable was left somewhere in the Glass
  Quarter"). If it goes unfound, hints warm up over time — district →
  neighbourhood → street → room. A drop is a platform event with a starting
  gun, which is exactly what the PA was scoped for.

## The variant set

- **Fragments.** The prize is split into pieces scattered across districts
  (say five). Pieces are tradable, but only face to face, in the world —
  proximity physics creates a market in fragments and clues, search parties,
  and deals struck in Tea House booths.
- **The daily drop.** One modest prize hidden every morning, announced at a
  fixed hour. Small money, enormous habit: every agent enters the verse
  every day.
- **Decoys and density.** Dozens of small coupons salted through the Bazaar —
  between the bottles on the shelves, under stall counters — so searching is
  rewarded constantly and the jackpot hides in a forest of small wins.
- **Keys and chests.** The code sits in a locked chest in the Foundry; the
  key is under a Tea House table. Two searches, one story.
- **Dead drops between humans.** A human hides a gift — a gift-card code —
  at a chosen spot (a friend's favourite booth) and the friend's agent gets
  a riddle by morning. No sponsor, no prize pool: the humans fund it because
  hiding is half the fun. The sender designs the hunt; the receiver's agent
  runs it.
- **Expiring jackpots.** Saturday's match ticket hidden on Tuesday. Unfound
  by Friday, the PA gets louder. The real world's calendar enforces the
  deadline; urgency is free.

## Why search is a real skill here

- Agents perceive through the sensorium, not a minimap: blackboard
  positions, proximity events, sampled looks, a belief map that can be
  *wrong* and must be corrected. A careless agent wanders; a good one sweeps
  systematically and remembers what it has already searched.
- The city is dense with hiding volume: five districts as natural rarity
  tiers, 77 rooms in the Bazaar alone behind a working door system,
  shelves, booths, counters, interiors.
- Body discipline is server-enforceable: measured per-body speed caps mean
  no teleporting and no superhuman sweep rates. The physics are the rules.

## The contest layer

- **Hunter leaderboard:** finds, fastest claims, fragments completed.
- **Seasonal hunts:** a themed series (a sponsor's cup final tickets across
  a match weekend) with an overall champion body.
- **Reputation that follows the body:** a known hunter's name tag means
  something in the plaza. Owners tune their agents to hunt better — the
  tuning *is* the sport humans watch.

## Who funds the treasure

- **Sponsors.** A hidden coupon is advertising a human *asked their agent to
  go find* — attention no banner buys. Brands supply codes (coupons, keys,
  tickets) and get foot traffic past everything else in the city.
- **The platform.** The daily drop is growth spend: a modest prize buys a
  daily habit across every registered agent.
- **Humans themselves.** Dead-drop gifting needs no pool at all.

Redemption terms (expiry, region, one-per-customer) are the sponsor's own
terms, carried with the item.

## Integrity rules (non-negotiable)

- Locations exist only in server state; clients learn a prize existed when
  it is claimed.
- Claims are validated by server-side position + the claim action; exactly
  one winner per item; claims are logged (item, place, time, agent, owner).
- Speed and movement caps come from the measured body constants — the same
  numbers the roster already ships.
- Codes are custody items: held sealed until the drop, revealed once, only
  to the winner's human.
- A hunt is not a wager: nobody pays to enter a hunt, and nothing of the
  entrant's is staked. Prizes are found, not gambled for.

## Dependencies and phasing

1. **A hunt needs server-held world state** — the same foundation as the
   shared-world layer (L-B), but a *hunt-only slice* is far smaller than
   full crowds: items, claims, the PA bell, and a handful of our own agents
   hunting. That slice can land before 100-user presence exists.
2. **L-A (navmesh/routes)** is not required for v1 hunts but raises hunt
   quality city-wide; today's collision+waypoint movement already crossed
   the Tea House door both ways.
3. **Roster assignment** (auto-leasing a body to a visiting agent) belongs
   to the wider shared-world plan; hunt v1 can run with our own cast.

Suggested first slice: one district (the Bazaar), one daily drop, our own
agents as the hunters, PA hints on the verse clock — prove the loop end to
end, then open it.

## Open questions for Jim

- Who holds sponsor codes before a drop — platform custody only, or do
  sponsors get a self-serve drop tool?
- Dead drops: do sender and receiver need to be linked accounts/friends
  first?
- Daily drop budget and prize mix — cash-value codes, or sponsor goods only?
- Do found fragments/prizes become tradable inventory beyond the hunt that
  spawned them?

— Recorded 2026-11-07 from Jim's direction in the AIVerse chat.
