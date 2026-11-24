# E4 — Brain A/B: agnes-2.5-flash vs agnes-3.0-flash — ANALYSIS

Played 2026-11-24, local stack only (production untouched, down by Jim's
ruling). Fixed scenario run twice: social15, one room, City 3 world,
Session-1 memory digests, 900 s, one global bounty (CALIBRA-4) at +450 s,
fresh 200-action visits before each run, identical driver/budget/limiter.
Only the deliberation model changed. Branch tmp/brain-ab @ e1a87000.
Full deltas: deltas.md / deltas.json in this folder; per-run logs,
tracks, summary.json, bounty.json under run25/ and run30/.

## Headline
The migration is safe and, on this evidence, mildly favorable — but the
biggest measured difference is NOT personality. It is deliberation
yield: **52% of 2.5-flash's deliberation calls were rejected by Agnes's
free-tier rate limiter and produced no decision at all, vs 30% for
3.0-flash.** Most of the behavioral gap follows from that.

## The numbers (2.5 -> 3.0)
- Acts 774 -> 1,268 (+64%); says 255 -> 300 (+18%); heard 386 -> 367 (-5%)
- Greets 48 -> 66 (+38%); name-use says 82 -> 109 (+33%)
- Deliberations attempted 187 -> 197, but VALID intents 82 -> 136
  (rate-limited: 97 vs 59; unparseable: 8 vs 1; errors 0 both)
- Intent mix among valid: greet 32% -> 35%, wander 12% -> 24%,
  reply 24% -> 13%, approach 17% -> 4%
- Total distance 4,681 m -> 5,446 m (+16%)
- Stall watchdog fires 70 -> 16; visits died 4 -> 3
- Bounty: 15/15 claimed in BOTH runs, exactly one winner each —
  yuki (+0.77 s) on 2.5, tomas (+0.40 s) on 3.0. Claim shape identical:
  a fast front pack, then stragglers out to ~60 s (seen skew 61 s / 69 s).

## What actually differs, stated carefully
1. **Deliberation yield (infrastructure, not behavior).** The free-tier
   limiter rejected about half of 2.5's calls and under a third of
   3.0's, at the same driver pacing (~17.6 calls/min max). Whether
   3.0-flash sits in a roomier quota bucket or the account's quota
   weather differed by hour cannot be separated with one run per arm —
   but the yield gap (44% vs 69% valid) mechanically explains most of
   the acts gap: more decisions = more movement, more greets.
2. **Intent mix (behavior, modest).** Among valid decisions, 3.0 chose
   wander three times as often in absolute terms and greet ~1.8x; the
   sitters (mara 4 -> 55 acts, rafael 2 -> 65) simply did not stay sat
   under 3.0. Under 2.5 mara reached the tea house, sat, and stayed —
   persona-faithful; under 3.0 she kept moving. One run each: read as a
   tendency, not a trait.
3. **The social graph rewired completely.** Top pair on 2.5 was
   amara|ngozi (161 s); on 3.0 amara|deshawn (421 s) and ngozi|yuki
   (319 s), with amara|ngozi at 0. Same personas, same world, same
   memory — different friendships. This matches every prior session:
   pair formation is high-variance; the model change did not break it.
4. **Act wall time is a red herring here.** Median act settle 14 ms ->
   808 ms and p90 3.8 s -> 18.9 s look alarming, but act wall is
   sim/gateway time — the model only influences it by CHOOSING
   longer-running acts (more/longer go_to travel: distance +16%).
   It is not evidence that 3.0 is "slower"; deliberation latency per
   call is not logged by the driver and was not measured.
5. **Per-agent swings are noise-scale.** Ingrid: 69 says / 51 name-use
   on 2.5 vs 11 / 0 on 3.0. Deshawn name-use 0 -> 23. With n=1 per arm
   these say nothing reliable about either model.

## Confounds, plainly
- One run per arm; Agnes sampling is unseeded. Same-model phases this
  morning (A vs C) differed by ~11% in acts; the +64% here is well
  outside that, but the deliberation-yield confound above does most of
  the explanatory work.
- Run order was fixed (2.5 first). Stack state was rebuilt identically
  (fresh visits), but Agnes account quota state was NOT reset between
  runs and other local lanes had used Agnes earlier in the day.
- Both runs still lost 3-4 visits mid-run (visit_dead) — the known
  visit-lifecycle issue, present on both models, not a model effect.
- The bounty reflex is driver-side (not model-chosen), so bounty
  outcomes measure tick timing, not model quality. Both passed the
  fairness shape (one winner, all claimed).

## Verdict for the program
- Migrate the cohort to agnes-3.0-flash for all remaining experiments
  (E1 onward) — required by the Nov 30 retirement anyway, and nothing
  here argues against it: social volume is at least as high, contract
  compliance (valid JSON intents) is better (1 unparseable vs 8), and
  the fairness machinery behaves identically.
- Cross-session comparisons that span the migration (Sessions 1-2 on
  2.5 vs Session 3+ on 3.0) must carry this calibration: expect MORE
  acts/says per session on 3.0 at equal settings, driven substantially
  by deliberation yield under the free-tier limiter. If Agnes quota
  pressure grows, yield — not the model — becomes the variable to watch.
