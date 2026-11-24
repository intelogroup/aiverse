# City 3 interaction stress probes

Run with the repo's installed dependencies from the root.

```sh
bun experiments/city3-interactions/stress.ts
bun experiments/city3-interactions/cup-grip.mjs
```

Run the Tea House custody rehearsal against the local `aiverse_test` database with the `vector` extension enabled.

```sh
VERSE_LAB_DATABASE_URL=postgres://postgres@127.0.0.1:5545/aiverse_test \
  bun experiments/city3-interactions/tea-cup-rehearsal.ts > rehearsal.json
```

The rehearsal uses scripted world bodies for navigation and the `Drinking` clip, and PostgreSQL for cup ownership and duplicate-request handling. It traces the handoff, concurrent pickup attempts, explicit recovery after detaching the holder, and reuse by a new visitor. The JSON records sampled poses and committed custody changes. The pgvector check verifies the local extension is enabled. This scenario uses no embeddings.

Run the greenfield persistence prototypes against the same database.

```sh
VERSE_LAB_DATABASE_URL=postgres://postgres@127.0.0.1:5545/aiverse_test \
  bun experiments/city3-interactions/greenfield-rehearsal.ts > greenfield.json
```

These fixtures exercise parcel redirects, stall succession, expiring permits and commitments, superseding district notices, room layouts, performer replacement, and owner acceptance of a procedure replayed in another room. The notice retrieval uses synthetic vectors and a new connection. The fixtures create and clean up their own schema. They do not attach world bodies or publish a public API.

The simulator probe loads the shipped City 3 collision and runs car entry, driving, braking, exit, Tea House entry, sitting, standing, radio use and exit for six agent bodies at 20, 30 and 60 Hz. Each row records the settled outcome, observed clips, public body visibility, final posture, room and travel distance.

On the initial run the radio failed 18/18 from a valid Tea House approach. After routing prop approaches through the collision-aware planner, the radio completed 18/18 with the Interact clip. All nine actions completed in each of the 18 final runs. Car entry and exit completed as state transitions with no EnterCar or ExitCar clip. The body disappeared from the public stream while driving and returned at exit. A production boarding sequence needs a driver-side approach, door pivot, seat and exit anchors, and a public pose between reservation and seating so spectators can see the transition. The current streamed car GLB has no baked door animation.

The cup probe uses the shipped character rigs and Drinking clips with a procedural cup. A single scene object transfers from a fitted tabletop marker to the left hand, follows the animated hand, and returns to the table within reach. The harness checks rejection for out-of-reach pickup, a second claimant, early release and wrong-owner release, plus recovery on cancellation. All 18 rig and sampling-rate combinations returned the cup. The grip stayed within 0.002 mm of the tracked hand point. The maximum placement correction was 2.84 mm with fitted markers. The hand's initial position differed from Summer's reference by up to 8.65 cm across bodies.

These are stage measurements for ownership and tracking. The cup has no published world action and the prototype starts with the hand aligned to a fitted marker. The rim-to-head measurement is a proxy. Physical pickup, a knuckle-side grip, rim-to-lip contact, tilt and liquid, and synchronization for all viewers need an authored fixture and visual validation.

The [PR reruns](pr-reruns/README.md) include a claim-window replay and the Villa walk and parcel redirect traces.
