# Tea House elevator: mechanics and lifecycle plan

Design record; implementation details and verification are in `23-tea-house-elevator-runtime.md`. Based on the four-floor structure and main integration in PR #67. Keep the model simple until the complete passenger journey works.

## Passenger journey

Summer walks through the Tea House entrance into the core lobby, approaches the lift and presses Call (or Up/Down on intermediate floors). The button lights; an indicator shows the car’s floor and direction. The car arrives, stops level with the landing, chimes and opens both its cabin doors and that landing’s doors. Summer walks in under normal player control, chooses G/1/2/3, and sees the selected button light. The doors wait, check the threshold, close and lock. The cabin accelerates gently, carries Summer and her camera continuously, slows and levels at the destination. Doors open, Summer walks out, and the controller releases her cabin support. After the doorway clears, the lift closes and serves the next request. If no request remains it parks closed at its last floor.

Manual movement and looking remain available in the cabin. No automatic walk-in or forced camera cut is needed. Cabin travel uses a standing animation unless the player actually walks. A short arrival chime and quiet motor sound follow the existing sound-consent setting. The lift works silently when sound is disabled.

## Geometry and floor contract

| Item | Authored value / decision |
|---|---|
| Stops | G Tea House 0.48 m; 1 salon/community 4.40 m; 2 homes 201–203 7.90 m; 3 homes 301–303 11.40 m |
| Total passenger travel | 10.92 m |
| Shaft in drawing coordinates | u=17–19.7, d=8.5–11.7 |
| Shaft in world XZ | X=−20.5…−17.8, Z=−84.2…−81.0 |
| Door centre / landing face | u=18.35, d=8.5; world X=−19.15, Z=−81.0 |
| Clear door opening | 1.10 m wide; retain the existing 2.25 m structural opening |
| Target clear cabin | 1.60 m wide × 2.10 m deep × 2.20 m high |
| Pit floor / shaft top | −0.52 m / 15.20 m; neither is a passenger stop |
| Cabin entry | Single front entrance at every floor, facing the core lobby |
| Door type | Two centre-opening sliding leaves on cabin and each landing |

Centre the cabin on u=18.35, placing its front immediately behind the landing sill and its depth toward the rear of the shaft. Measure exact skin, sill, roof, panel-pocket and door offsets in the actual mesh before export. The target cabin is a design envelope, not a claim that supplier clearances have been engineered. Check cabin roof clearance at floor 3 and underside clearance at G. Use thin walls, a closed roof, a solid floor, small control panel, handrail and light; no decorative/high-poly pass.

Use one floor manifest derived from `plan.json` for geometry, controller, buttons, collision and cutaway. Labels are display text; stable stop IDs are G/L1/L2/L3. Floor buttons never directly set an actor’s height.

## Separate the assemblies first

`blockout.py` currently combines lift door placeholders with each floor’s shaft walls in the `lift` category. Do not hide or delete `G_lift`/`L*_lift` wholesale: these groups also contain structural walls and pit protection.

Generate named landing-frame and left/right landing-leaf objects with stable stop IDs, plus a separate cabin root containing its floor, walls, roof, cabin leaves and controls. Export structural shaft walls as static geometry and keep only the removable closed-door placeholders separate. Update `prepare.mjs` and both visual/collision assets together. Keep landing sills continuous with each floor; the gap must be too small for the walker to lose support. Doors need real lateral pockets and must not retract into a public passage.

The car has one dynamic collision assembly. Landing leaves have per-floor dynamic blockers. All door leaves, walls, roof and guards are `noGround`; only cabin floor and landing sills provide support. Retain a full opening blocker until a doorway is wide enough for the capsule plus a margin, even if the visual leaves have begun opening. At a closed stop, prevent access to the pit/shaft regardless of where the cabin is.

## Controller and state transitions

Use a pure TypeScript `TeaElevatorController`, independent of React and mesh rendering. One simulation owner ticks it once per fixed step, regardless of actor count. Visuals, HUD and collision consume the same immutable snapshot. Inputs are call, select destination, hold-open, close, obstruction and actor presence; reject invalid stop IDs and impossible commands.

| State | Behaviour | Exit condition |
|---|---|---|
| INITIALIZING | All landing openings blocked; load/validate geometry, colliders and stop manifest | Ready: cabin parked at G, doors closed; failure: UNAVAILABLE |
| IDLE_CLOSED | Stationary, locked, no active trip | Call here: OPENING; request elsewhere: DISPATCH |
| DISPATCH | Choose next service stop and confirm departure interlocks | All interlocks valid: MOVING; otherwise remain safely stopped |
| MOVING | Run bounded acceleration/cruise/deceleration profile with doors locked | Near target: LEVELING |
| LEVELING | Complete final approach and settle at the exact stop datum | At datum and zero velocity: OPENING |
| OPENING | Unlock only the aligned landing and cabin leaves; animate together | Fully open: OPEN_DWELL |
| OPEN_DWELL | Allow boarding/exiting; announce arrival; reset timer while obstructed | Clear threshold and dwell elapsed or accepted Close: CLOSING |
| CLOSING | Animate both leaf pairs while continuously testing swept doorway volume | Obstructed: REOPENING; fully closed and locked: DISPATCH or IDLE_CLOSED |
| REOPENING | Stop closing, open smoothly from current leaf positions | Fully open: OPEN_DWELL |
| RECOVERING | Block unsafe openings; resolve a stopped/invalid journey | Safe aligned landing: open for exit, then UNAVAILABLE; otherwise hold protected cabin |
| UNAVAILABLE | Reject new calls with visible status; closed landing protection remains | Explicit validated reset: INITIALIZING |

Every transition is guarded; a timer alone cannot prove doors locked, cabin present or threshold clear. No motion with an open/unlocked cabin door or landing door. No landing may open unless the cabin is present, stationary and level there. One landing pair can be unlocked at a time. Sensor checks cover both sides of the sill, the capsule’s full body volume and the swept closing volume, not just a foot point.

## Motion, timings and dispatch

Initial tunable defaults: maximum speed 1.20 m/s, acceleration/deceleration 0.80 m/s², door opening/closing 1.50 s each, minimum dwell 4 s. Use an analytic trapezoidal profile (triangular when distance is short), including reversal only after a complete stop. A one-floor ride is roughly 4.4–4.8 s of movement; G to 3 roughly 10.6 s, plus doors/dwell. Do not promise exact journey times until play-tested. Stop acceptance: ≤1 cm height error and ≤0.01 m/s speed, then settle exactly to the datum before unlock. Cap acceleration changes for visual comfort; no overshoot or bounce.

Deduplicate hall calls by (floor,direction) and cabin calls by floor. Terminal floors expose only their valid direction. Serve cabin requests and compatible hall calls ahead in the current direction, then reverse when no work remains ahead. Opposite-direction hall calls remain pending; bound waiting with an age-based priority at the next dispatch boundary. Once moving, do not retarget across the current braking envelope. New calls can add a reachable stop ahead or queue for the following run. Current-floor calls open/reopen while stationary; requests during closure cause reopening when appropriate. Clear hall lamps only when the correct directional service is delivered, cabin lamps on arrival/opening. An empty car still serves hall calls.

Hold-open extends dwell while pressed, with threshold sensing always taking precedence. Close requests shorten dwell only after the minimum boarding interval and only while clear. Repeated obstruction keeps the car open and shows “Doorway blocked”; no forced closing/nudging. Avoid a fake emergency-stop button: first release offers an accessible Help/status action with local recovery messaging, not an implied live emergency service.

## Carrying Summer and other actors

The existing `walker.step` only handles static ground and gravity; simply animating a mesh under Summer will cause drift, falling or stepping artefacts. Add an explicit moving-support contract shared by player and agent walkers.

1. At the start of each fixed simulation step, advance the controller and compute the cabin transform delta.
2. For actors already supported by the cabin, apply that delta to feet position and camera anchor before their normal movement step. Keep horizontal coordinates relative to the cabin while it moves; do not repeatedly snap actors to its centre.
3. Resolve normal walking against the cabin-local floor/wall/door collision and current landing geometry. A cabin-local BVH can remain fixed; transform queries into its coordinates. If using world-space colliders instead, update transforms/BVH query coordinates consistently rather than rebuilding a BVH every frame.
4. Re-evaluate support at the sill after movement. Transfer landing→cabin or cabin→landing only when a real walk crosses the threshold onto the new supported surface. A half-boarded actor obstructs closing and cannot be carried away.
5. Publish actor height, camera and cutaway from the same post-step snapshot. On arrival retain support until the actor walks out. Vertical cabin travel is support motion, not a falling velocity; clear stale `vy` appropriately.

Cabin floor support must win over lower pit/landing floor hits. Its roof must never become ground. Preserve both staircases and all existing static-ground behaviour. Run input cannot push through closed doors or climb their tops. Add a small cabin movement speed cap if normal running makes the space awkward; decide from play-testing.

Register actor IDs with 3D bounds, support ID and last-seen simulation time. Everyone in the doorway blocks closure, not only the user who called. An actor disappearing releases its reservation after controlled removal; a stale TTL must not erase a currently registered physical obstruction. For the 1.60×2.10 m cabin start with a conservative two-adult admission limit, subject to two-capsule turn/exit tests. Others wait clear of the opening; arriving passengers exit first. Once aboard, each passenger can choose a destination. Do not despawn a rider for exceeding admission count; reopen and resolve boarding safely.

First implementation is local simulation: Summer and local NPCs share one controller. Cross-browser multiplayer synchronization needs a server-authoritative controller/occupancy protocol and is a separate change; a client must not imply the elevator is already shared across visitors.

## Controls, camera and feedback

- Hall panel: Call/Up/Down, current floor, direction, pending/arriving/unavailable feedback. Cabin panel: G/1/2/3 with room names, Open, Close and status.
- Interactions require proximity, matching vertical floor and line of sight; never activate another floor’s panel through a wall. Keyboard and touch targets share the same command API. Escape dismisses the panel without cancelling travel or releasing support. No camera lock is required to use it.
- Show contextual HUD only near the panel/in the cabin. Include pending destination and clear door-blocked messaging. Button states and announcements are accessible in the DOM; sound is supplementary.
- Walking camera follows the carried actor with bounded smoothing and cabin wall/ceiling clearance. Cutaway height follows actual feet during travel; do not switch to an upper floor merely because its datum was crossed. Spectator floor controls remain a separate view choice.
- Arrival updates the displayed floor only once level. A traveling indicator may show “2 → 3”; it must not report the next floor as reached early. Reduced-motion mode removes decorative shake, camera sway and indicator scrolling while preserving continuous physical travel.

## Lifecycle and failure recovery

Create the controller after its assets and collision are ready. Register dynamic colliders and camera obstacles once; replace the static door blockers only after dynamic replacements are active. Keep a protective blocker during handover. Keep the lift/collision resident while occupied, in motion or carrying requests. Never unload it just because the camera looks away or the room furniture streamer closes.

On walk-mode exit, detach that actor cleanly but keep the controller available to remaining actors. Re-entering walk mode must not spawn inside a shaft or absent cabin. Save only a validated parked floor for a fresh page load; initialize closed at that floor (G by default), clear transient requests, and spawn the player at a safe landing, not at a persisted midair pose.

Pause simulation when the tab is hidden; resume the same safe state without feeding a huge wall-clock delta into physics. Visual and collision motion use one simulation clock. A temporary frame hitch is subdivided into bounded steps. A long suspension freezes the cabin rather than fast-forwarding riders through multiple landings.

Normal unmount/scene switch must first transfer local riders to a validated safe landing and stop their cabin-relative velocity, then unregister support/colliders. React StrictMode setup-cleanup-setup must be idempotent and must not eject riders as a spurious development cleanup. Make recovery an explicit scene-transition transaction, not a render-effect side effect. Restore static landing protection before disposing dynamic leaves; release only owned meshes/materials/listeners/audio, never shared cached GLB resources.

If a fault occurs at a level landing, remain stopped and open only that landing for exit. If between floors with sound geometry, close/lock, stop accepting requests and perform a slow controlled recovery to the nearest valid landing; retain occupants and support throughout. If motion/collision state itself is invalid, freeze safely and show a “Return to landing” recovery action that deliberately relocates affected actors to a verified clear landing. This exceptional recovery is explicit, not ordinary elevator travel. Never open onto an empty shaft or silently drop the player into the pit.

Expose a development snapshot: state, cabinY/velocity, stop/target, direction, door fractions/locks, pending calls, obstruction IDs, supported actors, and last fault. Keep a small transition ring buffer for debugging.

## Implementation sequence and acceptance gates

1. **Geometry and manifest:** separate door leaves, create cabin/sills/panels, export visual and collision together. Gate: real dimensions, travel envelope and all four openings measured; static shaft protection retained; stairs/routes still pass.
2. **Pure controller:** states, motion profile, dispatch, locks, obstruction and recovery. Gate: deterministic fixed-step tests; no unsupported state can open a landing or move an unlocked car.
3. **Moving support:** cabin-local collision and actor transfer for Summer, then shared NPC adapter. Gate: ride both directions, walk/turn in cabin, cross sill at every floor, no drift/fall/head clipping and no roof-as-ground.
4. **Controls and presentation:** hall/cabin panels, status lamps, camera/cutaway, optional sound. Gate: desktop and touch journey from street→G lobby→3→G→street without debug commands.
5. **Lifecycle and regression:** scene changes, pause/resume, StrictMode and failures. Gate: clean resource ownership and successful recovery without an exposed shaft. Retest both stairs, 102 circulation routes, entrance pilot, radio and Remy.

Required test cases: calls from all four floors; G↔3 and every adjacent pair; repeated/invalid calls; current-floor call; competing up/down calls; new requests during motion; two passengers with different destinations; waiting passenger yielding to exiting passenger; capsule halfway across sill; obstruction late in closing; hold/open/close spam; blocked landing exit; actor leaving walk mode during a ride; inactive tab; frame hitch; scene teardown/remount; asset failure; mid-trip fault and safe recovery. Asset tests use the actual exported cabin and landing collision, not a bare-floor substitute.

Browser proof: record Summer walking from the Tea House door, calling the elevator, boarding, selecting 3, riding with visible continuous height change, exiting into homes 301–303, returning to G, and leaving. Also capture a doorway obstruction reopening and another landing remaining locked while the car is absent. Save video plus controller trace and exact asset/commit hashes. Only after those gates pass should the UI describe the elevator as working; ship via a new PR when requested.
