# E4 Brain A/B — deltas (Run 1 = agnes-2.5-flash, Run 2 = agnes-3.0-flash)

| metric | 2.5-flash | 3.0-flash | delta | % |
|---|---|---|---|---|
| total acts | 774 | 1,268 | +494 | +63.8% |
| total says | 255 | 300 | +45 | +17.6% |
| total heard | 386 | 367 | -19 | -4.9% |
| total deliberations | 187 | 197 | +10 | +5.3% |
| total greets | 48 | 66 | +18 | +37.5% |
| name-use says (total) | 82 | 109 | +27 | +32.9% |
| act wall ms median | 14 | 808 | +794 | +5671.4% |
| act wall ms p90 | 3,771 | 18,928 | +15,157 | +401.9% |
| observe ms median | 5 | 12 | +7 | +140.0% |
| stall watchdog fires | 70 | 16 | -54 | -77.1% |
| visits died | 4 | 3 | -1 | -25.0% |
| total distance m | 4,681 | 5,446 | +765 | +16.3% |

## Top encounter pairs (seconds within 6 m)

| pair | 2.5 | 3.0 |
|---|---|---|
| amara|deshawn | 141 | 421 |
| ngozi|yuki | 0 | 319 |
| henrik|tomas | 104 | 214 |
| amara|ngozi | 161 | 0 |
| fatima|ingrid | 0 | 150 |
| fatima|henrik | 0 | 146 |
| amara|lucia | 128 | 0 |
| deshawn|ngozi | 89 | 0 |

## Bounty

- 2.5-flash: winner=yuki, claims=15, seen skew=61106 ms
- 3.0-flash: winner=tomas, claims=15, seen skew=69191 ms

## Per-agent (2.5 -> 3.0)

| agent | acts | says | heard | delibs | name-use |
|---|---|---|---|---|---|
| mara | 4 -> 55 | 1 -> 1 | 8 -> 3 | 15 -> 15 | 0 -> 0 |
| deshawn | 128 -> 199 | 29 -> 58 | 31 -> 73 | 10 -> 13 | 0 -> 23 |
| ingrid | 43 -> 50 | 69 -> 11 | 3 -> 6 | 14 -> 13 | 51 -> 0 |
| tomas | 22 -> 39 | 3 -> 4 | 14 -> 8 | 13 -> 11 | 0 -> 0 |
| priya | 23 -> 31 | 9 -> 10 | 11 -> 12 | 15 -> 15 | 0 -> 0 |
| kenji | 80 -> 67 | 17 -> 8 | 50 -> 13 | 10 -> 14 | 0 -> 0 |
| fatima | 34 -> 34 | 8 -> 2 | 43 -> 15 | 13 -> 10 | 0 -> 0 |
| oleg | 30 -> 44 | 1 -> 1 | 6 -> 2 | 11 -> 12 | 0 -> 0 |
| lucia | 82 -> 109 | 23 -> 30 | 48 -> 29 | 12 -> 13 | 1 -> 8 |
| amara | 121 -> 199 | 31 -> 54 | 78 -> 67 | 8 -> 14 | 19 -> 47 |
| henrik | 30 -> 40 | 7 -> 9 | 9 -> 10 | 14 -> 12 | 1 -> 0 |
| yuki | 42 -> 95 | 13 -> 39 | 18 -> 67 | 16 -> 16 | 0 -> 0 |
| rafael | 2 -> 65 | 2 -> 1 | 4 -> 2 | 14 -> 15 | 0 -> 0 |
| ngozi | 102 -> 199 | 41 -> 71 | 47 -> 56 | 9 -> 11 | 10 -> 31 |
| sam | 31 -> 42 | 1 -> 1 | 16 -> 4 | 13 -> 13 | 0 -> 0 |
