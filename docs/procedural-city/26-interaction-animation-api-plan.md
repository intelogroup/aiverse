# City 3 animation and interaction API plan

Agents should choose an action on a visible object. The simulation should own the approach, alignment, animation, contact, object state and outcome. Start with the Tea House door, a seat, the radio and an egg. Together they exercise crossing, occupancy, reversible state and durable rewards.

## Current baseline

The cast catalog contains 53 clips on 12 rigs. All 636 combinations produced changing bone poses in the Three.js mixer, and 178 targeted animation tests passed. The full catalog and rig results are preserved in the animation audit. Twenty clips are agent-callable social gestures. Locomotion, sit and stand, door sequences, and prop handling belong to the body or interaction controllers. The raw Idle clip is present, while the tester's Idle command returns the character to its configured rest animation.

All four enterable buildings completed inbound and outbound traversals in the simulator. Only Matchmaker's Tea House used door choreography. On entry the current clip releases the knob around 4.66 seconds, then both leaves swing inward. On exit the pull already drives the first part of the swing. Stone Cabin, Lakeside Cabin and Zen Tea Pavilion use ordinary traversal through open doorways.

The current scene exposes nearby doors, seats and props. The Tea House elevator also exposes action markers through landmarks. The radio and six Bazaar eggs use the same `Interact` clip. Its generic contact is 1.5 seconds into the clip. The player prompt appears within 2.0 m of the stand point, the controller accepts a start within 2.5 m, and the agent executor can approach the stand point before handing off to the controller. Those distances serve different purposes. Egg stand points currently derive from a fixed 0.7 m offset, even for raised placements.

The local mechanics baseline passed 37 console tests and three legacy claim tests. In a stand-point probe the five ground-level eggs settled with a state toggle. The raised egg was visible but its interaction settled as blocked. A repeat probe left the six actions running at the 14-second observation cutoff. The radio was visible after a normal Tea House entry, but its approach stalled 1.8 m from the authored stand point. Reproduce the pending egg actions with phase traces and isolated fixture state, then fix the radio approach and the raised egg before comparing animation quality. These probes measured simulator state and did not score rewards.

Today, an egg can change its visible state during an interaction. An ordinary cosmetic or lore claim and a contest prize have separate gateway semantics. The legacy cosmetic endpoint accepts client-reported horizontal coordinates. The contest endpoint already checks the settled action, target, actor, freshness, contact pose and current proximity through the sim. Preserve that stronger contract. The placement documentation still describes an older 30-egg layout, while the checked-in manifest has six. Use the current manifests and sim as the baseline and correct the docs once behavior is settled.

See [clip catalog](../../packages/world-sim/src/clips.ts), [Tea House controller](../../packages/world-sim/src/teaDoor.ts), [prop controller](../../packages/world-sim/src/interactables.ts), [world actions](../../packages/world-sim/src/scout.ts), [legacy egg claims](../../apps/gateway/src/routes/eggs.ts) and [contest claims](../../apps/gateway/src/routes/eggHunt.ts).

## What to change

| Interaction | Authored anchors and conditions | Animation and state change |
| --- | --- | --- |
| Tea House entrance | Approach and heading on both sides, street palm point, interior knob point, threshold and exit point, leaf sweep clearance | Add a short street-side palm push and start opening at palm contact. Keep the interior pull. Walk through when already clear. Keep both leaves and block crossing until clearance is sufficient. |
| Open cabin and pavilion doorways | Approach and interior destination on the current floor | Keep ordinary traversal. Mark these as passable openings. Require explicit hinge, swing and obstruction data before adding a moving door. |
| Chairs and benches | Approach, seat position and facing, clear stand-up point, occupancy | Use the existing sit and stand family. Acquire the seat before mounting, hold it while occupied, and release it on standing, cancellation or detach. Test feet, pelvis and seat fit across rigs. |
| Radio | Walkable stand pose, button contact, hand and facing, powered state | Measure the current reach. Keep the generic clip only if it lands on the button on supported rigs. Bind the state change to verified contact and offer explicit on and off intents where retry-safe state matters. |
| Eggs | Visible surface and per-placement approach, floor, contact height, clearance and line of sight | Use an open or inspect reach suited to the object's height. Separate the visible opening, per-agent collection and any contest prize. Add a low or tabletop profile only after testing the matching contact and pose. |
| Elevator | Existing floor and panel markers, entry clearance and destination readiness | Keep the ride action. Validate the panel reach and alignment independently of motion and floor arrival. |
| Social gestures | Posture, loop duration and optional future partner rules | Keep direct `play` for the public gesture set. Review whether handshake should remain a solo gesture or gain an authored two-person interaction. Keep locomotion and traversal clips system-owned. |

For each authored interaction, define the object-local transform, eligible sides or floors, approach pose and facing, contact point and normal, hand or body anchor, contact interval, exit pose, and state conditions. The sim converts these to world space. Separate observation range, prompt range, the start conditions for an automatic approach, and the final contact tolerances. Calibrate alignment against the available rigs. Use a measured normalized clip event with the server's action clock. A missing clip, interruption or skipped render frame must yield a well-defined receipt. In particular, distinguish a clip reaching its authored contact event from a clip stopping early.

Audit visual correspondence for all 53 clips on a reference rig. Review Idle and gait transitions, blend edges and one-shot recovery. Review the door, seat, radio and egg interactions on every player-selectable rig, and exercise NPC paths for every rig that performs them. Capture fixed side and close-up angles with the rig, animation time, anchor and state change visible. Reuse a suitable clip when measured contact and posture meet the gate. Author or retarget a dedicated clip where they fail.

## API contract

Add typed affordances to the existing REST observation and return the same content in `world_observe` over MCP. Use existing object identifiers and action verbs. One example for a visible radio follows.

```json
{
  "id": "tea-radio",
  "kind": "interactable",
  "affordances": [{
    "action": {"type": "interact", "target": "tea-radio"},
    "state": "off",
    "readiness": "approachable",
    "distanceM": 3.4,
    "distanceTo": "approach",
    "autoApproach": true
  }]
}
```

- Report whether the actor can start from here, needs to approach, or is blocked. For blocked actions expose a stable reason and a supported recovery such as standing up or waiting for occupancy to clear. Label what distance is measured to. Keep render-only hand positions and clip timestamps in diagnostic traces.
- Keep `enter`, `sit`, `stand`, `interact`, `ride_elevator` and `play` as the primary verbs. Use an exact observed target for new clients. Measure old alias usage before changing legacy resolution. Keep `GET /world/clips` as the gesture list.
- Extend the existing asynchronous action record with optional phase, target and typed refusal or completion details. Phases should cover approach, align, perform and settle, with a state-transition event at contact. The same action ID and payload should replay the same authoritative record. Expose the resolved action and result in REST and MCP and keep existing text details usable by older clients.
- Give observed eggs an availability state from the sim and collection state from the gateway where needed. Apply the same eligibility rules to observation, action resolution and error hints. Keep the hunt clue separate from scene observation and keep contest proof in the existing claim flow. A claim uses the sim-recorded actor, exact target, interaction outcome, freshness and proximity. Treat visual opening and durable claim as distinct outcomes. Keep receipts recoverable across retries and preserve prior claims. Gate any new collection of value on server-verified state.
- Preview the structured fields in additive mode first. Update SDK types and the world guide from the same contract. Compare old and new clients against the same simulator before enabling the new interactions by default.

## Experiments

| Experiment | Comparison and cases | What to measure |
| --- | --- | --- |
| Animation and marker calibration | Current Tea House entry versus synchronized push. Both directions, already open, off-angle approach, blocked leaf and shared doorway. Repeat at 30 and 60 Hz and under delayed frames. | Palm-to-anchor error, leaf angle at contact, threshold clearance, feet and body intersection, traversal outcome, cancellation, action time. Capture video and a synchronized trace. |
| Object and collectible mechanics | Radio on and off, occupied seat, elevator at correct and wrong floor, all six egg placements including the raised egg. Test visible, occluded, wrong floor, blocked approach, distance boundary and out-of-reach placements. | Correct target and state, first approach success, truthful refusal, completion after expected contact, hand or seat alignment, actual settlement. Record each placement by stable ID. |
| Agent action selection | Same current world and tasks with existing observation, structured affordances with the same executor, and structured affordances plus semantic approach and grounded results. Include a small and a stronger model. | Correct first choice, task completion, wrong-target attempts, retries, observation calls, time and spend. Track discovery, selection, approach, contact and settlement separately. |
| Concurrency and claims | Two actors using one door, seat, radio or egg. Retry the same action ID, cancel before and after contact, detach, restart and retry an eligible claim. Use a test-only contest and synthetic rewards. | No duplicate durable grants, no orphaned reservations, stable replay receipts, correct shared visual state, and equivalent REST and MCP results. |

Rehearse every fixture with a scripted driver before scoring model behavior. Verify that the relevant object actually appears in the agent's observation and that the route and contact are possible. A missing exposure or blocked fixture is an infrastructure result. Score model decisions separately. Then run paired trials with fresh visits, matched starting poses and tasks, and rotate condition order. Start with 12 paired scenario seeds per model as an engineering pilot and expand if the outcome is unstable. Keep raw action records and simulator poses. For human review, show the same shots in randomized order and score naturalness, clarity of cause and effect, and visible clipping.

Proposed release gates are zero duplicate grants or early state changes in the scripted matrix, zero crossings through closed leaves, passing REST and MCP compatibility checks, and at least 95% exact-target success for reachable fixtures in scripted runs. Use an initial review target of at most 10 cm palm-to-anchor error for new contact clips at the authored contact moment, then adjust by object and rig based on render review. Adopt agent-facing affordances when the paired pilot improves correct action selection or first-attempt completion without materially increasing calls or latency. Record the denominator and failed scenarios alongside every rate.

## Implementation order

1. Capture current behavior and align placement manifests, authored markers and docs. Add traces for approach, contact and outcome so the baseline and changes can be compared.
2. Switch Tea House street entry to an authored push and preserve the measured exit pull and open-door traversal. Use the same marker contract to validate seats and calibrate the radio.
3. Validate all six egg approaches and split a visual opening from an authoritative collection receipt. Migrate the legacy cosmetic claim path with compatibility coverage. Reuse contest proof and keep test rewards local.
4. Expose the additive affordances and action details in REST, MCP and the SDK. Run the paired agent study and visual review, then use the release gates to decide which interactions to enable.
