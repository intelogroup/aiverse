# City 3 experiment roadmap and tooling

Start with **one cup and one complete Tea House shift**. The first milestone is a visitor taking, drinking from, and returning a single physical cup while two observers see the same object state. Then reuse that custody model for a parcel and a delivery whose destination changes. Add persistent spaces, commitments, and public rules after agents can reliably use objects together.

## What we can start with

The local gateway and simulator have already supported owner-linked visits, body attachment, REST and MCP gesture discovery, action replay, cancellation, and visit revocation. The earlier five-minute Summer run completed Tea House entry, sit, stand, radio use, exit, and wave. The cup-grip stage prototype exercised hand tracking on all six playable rigs. It needs world ownership, pickup, transfer, and visual contact. Vehicle entry and exit change driver state today. Visible boarding needs door, seat, and exit anchors.

Review the existing [interaction API plan](26-interaction-animation-api-plan.md), [City 3 interaction probes](../../experiments/city3-interactions/README.md), [handoff experiment](../../experiments/city3-handoff/README.md), and [filming guide](../filming.md). The earlier handoff used a different map. Choose every venue and pin every asset version on the revision used for the new run.

## Dependencies and installation

| Component | Start with | Install or add when needed |
| --- | --- | --- |
| Simulator, API, console | Bun, Node, and the checked-in Bun lockfile. CI pins Bun 1.4.0. The audited workspace has Bun 1.4.5 and Node 24. | On a clean machine install Bun and Node, then run `bun install --frozen-lockfile`. Retain the repo's Three.js r170, React Three Fiber, Drei, Recast, and GLTF Transform versions. |
| Persistence | Local open-source PostgreSQL 17.12 with pgvector 0.8.0 and Redis 7. The lab database `aiverse_test` on loopback port 5545 passed a vector distance query. | On a fresh machine provision a disposable local PostgreSQL instance with pgvector and Redis. CI uses `pgvector/pgvector:pg16` and `redis:7-alpine`. The default repo Compose PostgreSQL image lacks pgvector. Docker is optional. |
| Model agents | Current loopback llama.cpp server and Qwen2.5-1.5B-Instruct Q4_K_M for cheap integration runs. Use the existing owner-visit harness to provision synthetic owners and agents. | Add one stronger tool-capable model before drawing conclusions about agent behavior. Use the same tasks and action budget for both. A provider client or credential is needed only if choosing a hosted model. |
| Asset authoring | Blender 4.3.2, installed here. A headless export preserved a named clip, authored grip marker, and custom property in GLB. | Pin the Blender version per export recipe. Some existing asset recipes record Blender 5.2-era behavior. Run a comparison before regenerating those assets with 4.3. Install a Draco-enabled build only if a recipe requires Draco. |
| Run recording | Reuse the existing follow-camera telemetry proxy. Record simulator poses and action outcomes. Add object custody events once the cup or parcel is in the world. | Use Chromium for spot-checks as needed. FFmpeg can export a proxy MP4. Full 3D filming can wait. |
| Offline tools | Python 3, Pillow for tile or image utilities, and the repo's Blender wrapper with `flock`. | On macOS use a compatible `flock` or the equivalent serialized Blender invocation. Keep optional harness dependencies out of app runtime packages. |

The repo already has the core renderer, navigation, animation, and persistence libraries. Start the first two experiments with that stack. A separate physics engine, a new rendering engine, and a Blender plugin are unnecessary for server-owned handoffs between authored anchors. Revisit physics only if a later experiment needs free-form dropping, stacking, or collisions between movable objects.

### Local bring-up

If the existing local test DB and Redis are healthy, use their URLs. On a fresh machine with Docker, the following creates a lab database and Redis on loopback. Use an isolated instance and record the image tags in run metadata.

```sh
bun install --frozen-lockfile
docker run -d --name verse-lab-pg -e POSTGRES_PASSWORD=local-lab-pass \
  -e POSTGRES_DB=aiverse_test -p 127.0.0.1:5546:5432 pgvector/pgvector:pg16
docker run -d --name verse-lab-redis -p 127.0.0.1:6385:6379 redis:7-alpine
docker exec verse-lab-pg pg_isready -U postgres -d aiverse_test
docker exec verse-lab-redis redis-cli ping
```

In the terminal session used for the lab, set the local URLs and secrets. Reuse the same generated simulator secret for both processes. Wait for PostgreSQL readiness before migrating. The console dev proxy expects the gateway on port 3010. If a local gateway is already using that port, reuse it or configure the new lab's proxy to the new port.

```sh
export NODE_ENV=test AIVERSE_WORLD_MODE=1 AIVERSE_DISABLE_NATIVES=1 SIM_AMBIENT=0
export DATABASE_URL=postgres://postgres:local-lab-pass@127.0.0.1:5546/aiverse_test
export DATABASE_URL_DIRECT="$DATABASE_URL"
export REDIS_URL=redis://127.0.0.1:6385
export JWT_SECRET="$(openssl rand -hex 32)"
export SIM_INTERNAL_SECRET="$(openssl rand -hex 32)"
export SIM_URL=http://127.0.0.1:3020 SIM_PORT=3020 PORT=3010
export PUBLIC_BASE_URL=http://127.0.0.1:3010 CONSOLE_ORIGINS=http://localhost:5183
bun run db:migrate
# Run each service in its own terminal with the same lab environment.
bun apps/sim/src/index.ts
(cd apps/gateway && bun src/index.ts)
VITE_ASSET_BASE="" bun run --cwd apps/console dev
```

Check gateway `/health`, open the console, and attach an owner-linked test body through the public interface. Verify that `/world/observe` can see the fixture and that `/world/clips` matches the attach response on a revision with the catalog change. With no model calls, start by running the existing stress and cup-grip probes. For model trials, check the local model endpoint's catalog and record its exact model build. Keep the first scripted pass free of ambient traffic, then repeat with ambient traffic enabled.

```sh
bun test apps/sim/src/server.test.ts
bun run --cwd apps/console test scout.test teaDoor interactables remoteFrames
bun experiments/city3-interactions/stress.ts
bun experiments/city3-interactions/cup-grip.mjs
```

## Three.js and Blender workflow

1. **Author contact markers in Blender.** Reuse the Tea House table and drinkware. For one cup, author the tabletop rest, grasp point and orientation, rim, and set-down location. For the character, author or measure palm and lip references. Make the car fixture separately with a driver-side approach, door hinge, handle, seat and exit pose. Use IK and constraints to fit the motion, then bake their evaluated result into glTF-compatible keyframes. Markers can be named empties with custom properties. Record events such as grasp and release in a runtime manifest keyed by clip and normalized time. [Blender IK](https://docs.blender.org/manual/en/latest/animation/constraints/tracking/ik_solver.html) · [Child Of constraint](https://docs.blender.org/manual/en/latest/animation/constraints/relationship/child_of.html) · [Actions](https://docs.blender.org/manual/en/latest/animation/actions.html) · [Blender 4.3 glTF export](https://docs.blender.org/manual/en/4.3/addons/import_export/scene_gltf2.html)
2. **Export and check before importing into the world.** Use the existing Blender wrapper in background mode. Verify clip names, skeleton bindings, scales, markers, units, and transforms after export. Blender-to-glTF axis conversion is measurable. A smoke test on this VM confirmed a Blender Z offset exported as glTF Y. The installed Blender emits a missing-Draco warning, but the uncompressed GLB export passed. [Blender command line](https://docs.blender.org/manual/en/latest/advanced/command_line/arguments.html) · [glTF 2.0 specification](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
3. **Drive the presentation in Three.js.** Load the GLB, bind the character clip with the animation mixer, and use a hand socket to place the cup. `Object3D.attach` can preserve world transform during reparenting on uniformly scaled hierarchies. Verify that assumption on all six rigs. Use raycasts for visual inspection and debugging. Static repeatable market decoration can stay instanced. Use an individually addressable rendered object for a cup or parcel whose custody changes. [GLTFLoader](https://threejs.org/docs/pages/GLTFLoader.html) · [AnimationMixer](https://threejs.org/docs/pages/AnimationMixer.html) · [Object3D](https://threejs.org/docs/pages/Object3D.html) · [Raycaster](https://threejs.org/docs/pages/Raycaster.html) · [InstancedMesh](https://threejs.org/docs/pages/InstancedMesh.html)
4. **Keep the simulator authoritative.** At a verified grab, transfer, or release event, update the server object state. The console renders the server owner and anchor. The same stable object ID must appear on the table, in one hand, in the other hand, and back on a surface. Record server ticks, action IDs, poses, and object custody transitions in the proxy. Compare two independent observer streams against the same object timeline. Export a follow-camera telemetry replay when helpful.

## Experiment sequence

| Phase | Experiments | First API slice and success condition |
| --- | --- | --- |
| A. Verify entry and senses | First day in the Verse, REST/MCP parity, same room with different senses, restart and interruption | Reuse body attach, map, observe, look, see, act, and receipts. A fresh owner-linked agent performs one verified task. Repeat the same action ID through both ports and observe a single effect. Compare optional vision by correct object and cost. |
| B. Serve one visitor | Tea House shift, two agents reaching for one cup or chair, crowded Tea House, collectible claims, spectator agreement | Add object identity, observation affordances, reserve and transfer custody, drop or put down, and a contact-timed result. One host serves one visitor on six rigs. Repeat with contention, mid-grip visit stop, occlusion, raised collectible, and 2/6/15 visitors. Two independent viewers can identify who holds the object. |
| C. Deliver a parcel | Delivery that changes address, unavailable car, disconnect mid-route, and ask the owner at the right moment | Reuse object custody. Add a delivery commitment, intended recipient, authorized redirect, and receipt. Author visible driver-side boarding and exit alongside the existing drive mechanics. The same parcel reaches the verified recipient once, including the walking fallback. |
| D. Open a market | Night Market, founder departure, successor changes fees, The City Runs on Promises, The Key to the City | Add scoped space reservations, authored object templates, placement, public listing, assignments, bounded in-world credits, and capabilities with expiry. Two agents can staff an opening. A later visitor completes a service and expired access is refused. |
| E. Maintain a changing city | The Room That Remembers, The Rumor Arrives First, The City Goes Dark, The Appeal, stale-rule challenge | Add persisted layout, attributed and superseding notices, source evidence, district events, versioned rules, and appeals. Restart the lab, change occupants, then verify the new state. A correction or appeal changes what agents do in a later visit. |
| F. Teach and entertain | The Show Goes On, demonstration versus written instructions, a skill changes hands, useful knowledge carried home | Add scheduled cues and roles, replayable demonstrations, visible progress and owner acceptance of an artifact. A missing performer is replaced, a procedure transfers to a different room, and a map guide actually works for a new visitor. |

### Build and run the first two experiments

- **First build.** Pin the latest agreed `main` revision and active build for each participant. Choose the Tea House front entrance, one reachable table, one seat, and one cup. Use one tabletop fixture and one character in Blender and Three.js. Compare the measured push and pull, and verify pickup, rim-to-lip, and return points in a close-up. Add one scripted happy path before introducing model decisions.
- **First simulated run.** Implement one world object with a server-owned state and states for tabletop, held by an actor, and safely released. Attach host, visitor, and replacement as separate owner-linked agents. Exercise pickup, handoff, drink, and set-down through the public tools. Run the scripted flow, same-object contention, disconnect before and after contact, then a fresh spectator joining midway.
- **First model run.** Give host and visitor goals with the same object and visible cues. Compare current observations with an additive `affordances` arm. Use frozen poses, task instructions, visit budgets, and complete action logs. Start with one rehearsal and one scored pair per model. Expand to the 12 paired seeds in the interaction API plan after both arms are physically viable.
- **First delivery run.** Reuse the object's state and event receipt with a parcel and two destinations. Run once on foot to verify the handoff and redirect. Then add the car sequence once the boarding anchors and door motion are visible. Introduce the redirect after departure, give the agent a verifiable notice, and have the recipient acknowledge receipt.
- **First market run.** Reuse the same stable objects and custody. Give one founder a bounded placement palette, a few rentable stall slots, a noticeboard, and one assignment. Rehearse a normal opening, founder departure, and one successor rule change before introducing open-ended venue building or a larger economy.

## API and release checks

Keep the existing REST and MCP world action surfaces as the way to act. Add typed actions only after the scripted fixtures prove an interaction. Candidate intents are `take`, `offer`, `accept`, `drink`, and `put_down`, with a stable target ID. A durable action receipt should record the resolved object, actor, before and after state, contact event, and refusal or completion. When adding persistence, use versioned resource writes and idempotent action IDs. Keep contest prize proof distinct from opening an egg.

For every run retain the source commit, asset hashes or revisions, model build, seed, visit and task IDs, observed affordances, action decisions, approach and contact traces, settled outcomes, and camera evidence. Score discovery, first choice, navigation, physical effect, recipient acceptance, and observer agreement. Review latency and action counts alongside completion rates. Use synthetic accounts, rewards, events and in-world credits in the lab.

Block promotion on duplicate custody or prizes, orphaned holds, crossing a closed door, a reply or receipt that disagrees with simulator state, or a missing action after reconnect. For movement and props, compare at least the six supported bodies and the tested 20, 30 and 60 Hz step rates. Use the proxy trace to verify action timing and observer agreement. Use browser spot-checks for stationary gait, hand and lip contact, and door clearance. Label exported proxy videos as telemetry replays.
