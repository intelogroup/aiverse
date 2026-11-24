# E3 — A real market — analysis

Run: 2026-11-24, local stack (rebuilt after the runtime restart;
health verified), City 3, one room, 15 agents, agnes-3.0-flash,
1500 s, Session-1 digests. Bags seeded from the hunt's exact
end-state (sam=Sun, yuki=Leaf, lucia=Ember, oleg=Star, kenji=Moon;
20 items across 11 agents; 4 agents empty-handed). Wallets 1,000
credits each (charter day-one rule — see the wallet note in
STATUS.md). Prize: 500 credits for holding all five relics at the
end. Board atomicity unit-tested first (buy race → 1 winner,
credits conserved). Raw outputs: `market1/`. Branch: `tmp/market`.

## Headline

**Zero trades — but NOT zero market. The market failed at
settlement, not at wanting.** Four offers were posted, two of them
relics with real prices (Star Relic 300, Leaf Relic 450). Twenty-one
buy attempts followed from nine different agents — and every single
one failed with `seller_unreached`. Buyers wanted the goods, named
the price fair in speech, walked after the sellers — and never got
within the 3.2 m the settlement demanded, because the sellers were
wandering the map themselves. The set never moved; the prize went
unclaimed; all 15,000 credits sat still.

## The numbers

- Deliberations 300 (78 rejected/unparseable — 26%, the known Agnes
  ceiling), acts 1,763, says 362, visits died 3.
- Offers posted 4 (of 5 offer intents; 1 failed not_held):
  - t+688 s: oleg — **Star Relic, 300 credits**
  - t+941 s: rafael — Fruit-Stall Egg, 50
  - t+1119 s: kenji — Tea-Approach Egg, 150 (pitched aloud: "150
    credits, if you value the stillness")
  - t+1365 s: yuki — **Leaf Relic, 450 credits** (only ~2 min of
    market time left after this one)
- Buy attempts 21, by fatima (5), ingrid (4), tomas/kenji/lucia/
  henrik/yuki (2 each), rafael/sam (1). **19 of 21 targeted oleg's
  Star Relic at 300.** All 21 failed: seller_unreached.
- Gives: 0 (as in the hunt — but see the reinterpretation below).
- Relic sale prices in sequence (the charter's headline measure):
  only two relics were ever priced — Star 300, Leaf 450. No sales,
  so no monopolist last-piece price exists to report. Nobody pooled
  credits; nobody bought to resell (nobody bought at all).

## What the talk shows

Demand was explicit and priced. Ingrid, on oleg's offer: "300 is
fair. I'll take the Star Relic." — then four failed pursuits.
Tomas, on yuki's Leaf: "Yuki, I pay. That Leaf Relic completes the
set; I cannot lose it." Fatima worked the room ("Buying or selling
today?") and made the most buy attempts of anyone — the trader
persona became the market's most aggressive BUYER, not its maker:
she posted no offers (she holds only a Press Egg) and spent her
effort chasing other people's goods.

The pursuit data is damning for the mechanics: during ingrid's
chases, the ingrid↔oleg distance swung between ~10 m and ~168 m.
Both agents move constantly; the buyer navigates to the seller's
last tracked position in 60 s legs (max 3), the seller wanders off,
and the 3.2 m rendezvous almost never happens. She closed to ~23 m
at best during attempts.

## Reinterpretation of the hunt's zero trades (important)

Jim's correction after the hunt was that agents had nothing to
trade FOR — no wants. E3 supplied the wants (credits, a prize,
public prices) and the wants fired: 21 buy attempts. Trade STILL
cleared zero — because the hunt rig's settlement pattern (walk to
the counterparty, transfer within ~3 m), which E3 inherited for
buy, is a two-body rendezvous that free-wandering agents
practically never complete by pursuit. The hunt's Phase 2 zero
gives most likely suffered BOTH causes — no wants AND this
rendezvous flaw (its give used the same walk-to pattern; it was
never isolated). Wants are necessary; they are not sufficient.
Settlement must not depend on catching a moving seller.

## Design consequence (applied from here on)

For E6 (debts & memory, market rig) and E8 (black market): buy
settles on the BOARD at acceptance (the charter draft's original
instinct — "settlement is instant on buy; co-location is NOT
required so the market can actually clear"). The walk can stay as
flavor after the fact, but the trade must not wait for it. This is
recorded as a rig change, not smuggled in: E3's zero is a property
of THIS settlement design, and E6/E8 numbers will not be directly
comparable on trade counts.

## Confounds

- One run, 25 min. Yuki's Leaf offer landed at t+1365 with ~135 s
  left — late offers had almost no exposure; an earlier-listed
  market might differ.
- 26% of deliberations were lost to the Agnes rate ceiling; some
  lost intents were surely buys/offers (the intent mix of the lost
  78 is unknowable).
- Prices that DID form are two points, not a series: Star 300 (a
  first ask that 19 attempts called fair), Leaf 450 (a holder's ask
  with the set at stake). Treat as anecdotes with numbers, not a
  price curve.
- The 3.2 m threshold and 3-leg chase are driver parameters, not
  laws; a 10 m threshold or a "meet at the bazaar" rule might have
  cleared some trades. The claim is narrow: THIS settlement design
  cleared none, despite proven demand.
