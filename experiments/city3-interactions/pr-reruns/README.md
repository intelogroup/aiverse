# City 3 claim timing and Villa delivery

## Claim window

The replay uses the saved arrival times from [PR #282](https://github.com/intelogroup/aiverse/pull/282). Run it with `python3 experiments/city3-interactions/pr-reruns/claim-window.py`. It awards one entry per agent and simulates a seeded draw among eligible agents. The original first claim arrived when only one agent was eligible. The 30-second window admitted 10 agents. A 60-second window admitted all 15, five per shard. The input and output are in [pr282-claims.json](pr282-claims.json) and [claim-window.json](claim-window.json). This replay holds arrivals fixed. A live cohort comparison would also measure how agents respond to the rule.

## Villa walk and parcel redirect

The recorded trial used main `9f0e122` with the playback and gesture patches, the Villa landmark from [PR #272](https://github.com/intelogroup/aiverse/pull/272), and its dam collision generator run on the local collision GLB. Recast rebaked the navigation mesh from that collision. The resulting collision SHA-256 was `aad42233d90bf3e5005add77b2f7b5cb9d519284164bf77f46d3a6b5e8e885f2`. The local visual world GLB stayed in place.

The courier reached the Villa from Stall 40 in 157 simulator seconds. All 54 samples on the crossing were at deck height. In the separate parcel trial, the courier heard a redirect while walking, cancelled its route, reached the Villa, and heard the recipient acknowledge the same parcel. Two concurrent receipt attempts yielded one database record. The speech observation was marked untrusted. The scripted harness made the decision to authorize the redirect and wrote the receipt to a disposable schema. See [walk trace](villa-walk.json) and [parcel trace](redirected-parcel.json).

To rerun, use an isolated checkout with the Villa landmark and the dam collision overlay from #272 applied to its own collision GLB. Rebake the navmesh using `bun packages/world-sim/node/bakeNavmesh.ts`. From that checkout, run the commands below. The committed traces preserve the original figure names. The runners use currently supported figures.

```sh
bun experiments/city3-interactions/villa-walk.ts
VERSE_LAB_DATABASE_URL=postgres://postgres@127.0.0.1:5545/aiverse_test \
  bun experiments/city3-interactions/redirected-parcel.ts
```

The owner-facing receipt, verified dispatcher identity, physical pickup, and autonomous delivery remain open.
