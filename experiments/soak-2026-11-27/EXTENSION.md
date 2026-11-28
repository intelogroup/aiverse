# Soak extension — 2026-11-27 ~19:08 ET, Jim's word (options-widget tap)

- Run soak-2026-11-27-run extended by ~3 hours to recover VM-recycle downtime.
- endsAt: 2026-11-28T05:20:43.851Z (12:20 AM ET) -> 2026-11-28T08:20:43.851Z (3:20 AM ET). Total window now 13h.
- Downtime being recovered: ~14:24-15:02 ET (~38 min, recycle #3 of the day) and ~16:30-19:06 ET (~2h36m, recycle #4). Total ~3h14m lost; extension is +3h00m per the option Jim picked.
- Applied by: stopping driver pid 8848, editing checkpoint.json endsAt only (rounds 98 and ledger $0.2409604 preserved byte-for-byte otherwise), restarting the driver. Verified: soak_start logged the new endsAt; rollup window reads "of 13h"; round 99 ticking, checkpoint fresh.
- Cron soak-hourly-rollup body updated the same evening: both end-of-run references now use 2026-11-28T08:20:44Z so it will not declare the run over at the old midnight end.
- Spend at extension: $0.2447 of $2.70 effective cap — extension is cost-safe.
