---
name: drive-car
description: Drive a car in AIVerse. Use for lane changes, three-point turns, intersection turns, traffic lights, crosswalks, yielding, or parking.
---

Use one tool at a time. Read its result and the available tools before moving. Get in with `drive_enter` and confirm `phase: driving`. If the cockpit camera is available, use `drive_look` ahead for lights and signs and toward the intended turn to see the entire crosswalk. Hold if you cannot tell whether a pedestrian is clear. `drive_check` checks for traffic that may be outside the camera view.

## Massachusetts practice lessons

- **Lane change.** Use the road view to read both lanes' arrows before approaching a junction with turn-lane markings. Locate your lane by its own arrow and the lane dividers. Make the change into the lane assigned to your destination. Broken white separates same-direction lanes. Check mirrors and the target-side blind spot and keep the signal toward the target lane on (set it before or after the check; an already-lit indicator stays valid). Wait for a safe gap and recheck before moving. A double solid white divider bars a lane change.
- **Three-point turn.** Use a legal, narrow road with good visibility and light traffic when there is no suitable alternative. Start near the right curb. Signal left and verify a safe gap in both directions, including the blind spot. Turn slowly across to just before the far curb and stop. Check both directions and behind over your right shoulder before backing toward the near curb. Stop short of it. Check both directions again, signal left, and pull forward in the opposite direction. `drive_three_point` executes one leg and stops before returning. The RMV recommends allowing a 20–30 second gap for the full maneuver.
- **Intersection turn.** Select the proper approach lane and signal at least 100 feet in advance on these streets. Use `drive_approach` to stop behind the line if required. Check mirrors, the turn-side blind spot, the intersection, and the destination lane. Yield to users with priority, including oncoming vehicles when turning left. Finish the turn in the proper lane.
- **Traffic signals (RMV Driver's Manual, Traffic Signals).** You must know what each light means and obey it at all times.
  - **Steady red = stop.** Stop fully before the white stop line or crosswalk line and do not go until the light is green. Never enter an intersection on red, and never because you were already moving.
  - **Right on red** only after a complete stop and after yielding to pedestrians and vehicles in your path, and never where a NO TURN ON RED sign is posted: then wait for green. **Left on red** only from a one-way street onto a one-way street, with the same stop and yield duties.
  - **Steady yellow = the light is changing to red.** Stop if it is safe. If you are already stopped at the line, you may not go.
  - **Flashing red** is a STOP sign: stop completely, then go when it is safe. **Flashing yellow** is a warning: slow down, look both ways, proceed with caution.
  - **Steady green = go, but first** yield to vehicles, bicycles and pedestrians in the road, and only enter if there is room to clear the intersection. Never block an intersection. Yield to pedestrians in the crosswalk even on green. A left turn on green yields to oncoming traffic.
  - **A light is not a one-time reading.** Read it early, read it again as you close on the line, and again at the line. If it turns yellow or red before you reach the line, stop; do not continue through because you have already started. An unreadable lamp is unknown, not green: use `signal_detail` and confirm it at the line. Report a change only when two readable frames show it.
  - **Crosswalk.** After any light or traffic change take a fresh view toward the turn. If a pedestrian is near the stripe edge use the detail view to place their feet and decide whether their path crosses yours. Hold until the crosswalk and your exit lane are clearly free.

The current route and controls come from observation. `drive_wait` holds at your present stop until the observed conflict changes. Confirm `lesson.passed` and zero speed before reporting that you finished. The rules above follow the Massachusetts RMV Driver's Manual, chapter 4.

## Real-time lessons
When `drive_observe` shows `lesson.senses`, the world runs on a clock. `drive_approach` with a `speed` (m/s, 3 to 20) returns at once and the car keeps moving. Poll `drive_observe`: `senses.horizon` gives the stop line's distance, time to arrival and light, and whether you can still stop (`canStop`). A yellow light means prepare to stop. The car stops before the line by itself unless you pass `stop: "none"`; with `none` it rolls through, which is legal only on green or yellow, so brake before the line on red. Use `drive_brake` to stop earlier; you then approach again. At higher speed you have less time per decision, so pick a speed you can manage: you need time to read, decide and brake. `check` and `signal` are allowed while moving; other maneuvers are not. When `activeCommand` is empty and `stoppedAtLine` is true you have arrived; finish the turn as usual.

## Night driving

Use `drive_headlights` to select low or high beam. Use high beams on dark roads with enough separation. Switch to low within 500 feet of oncoming traffic or 200 feet of a vehicle ahead. `drive_brake` holds the brake and illuminates the red stop lights until you drive again.

## Free drive

Use `drive_gas` for a distance or the left/right tools for relative steering. Bounded moves stop before returning. A turn defaults to 10°. Equal opposite angles restore the original heading. Use `drive_brake` for an explicit stop. At the yield junction follow `crossing.next`. Approach the line, yield while stopped, then cross and park. Confirm `crossing.status: past` and zero speed. Exit only while stationary.
