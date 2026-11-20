---
name: drive-car
description: Drive a car in AIVerse. Use for lane changes, three-point turns, intersection turns, traffic lights, crosswalks, yielding, or parking.
---

Use one tool at a time. Read its result and the available tools before moving. Get in with `drive_enter` and confirm `phase: driving`. If the cockpit camera is available, use `drive_look` ahead for lights and signs and toward the intended turn to see the entire crosswalk. Hold if you cannot tell whether a pedestrian is clear. `drive_check` checks for traffic that may be outside the camera view.

## Massachusetts practice lessons

- **Lane change.** Use the road view to read both lanes' arrows before approaching a junction with turn-lane markings. Locate your lane by its own arrow and the lane dividers. Make the change into the lane assigned to your destination. Broken white separates same-direction lanes. Check mirrors and the target-side blind spot, then signal for the lane change even if that indicator was already lit. Wait for a safe gap and recheck before moving. A double solid white divider bars a lane change.
- **Three-point turn.** Use a legal, narrow road with good visibility and light traffic when there is no suitable alternative. Start near the right curb. Signal left and verify a safe gap in both directions, including the blind spot. Turn slowly across to just before the far curb and stop. Check both directions and behind over your right shoulder before backing toward the near curb. Stop short of it. Check both directions again, signal left, and pull forward in the opposite direction. `drive_three_point` executes one leg and stops before returning. The RMV recommends allowing a 20–30 second gap for the full maneuver.
- **Intersection turn.** Select the proper approach lane and signal at least 100 feet in advance on these streets. Use `drive_approach` to stop behind the line if required. Check mirrors, the turn-side blind spot, the intersection, and the destination lane. Yield to users with priority, including oncoming vehicles when turning left. Finish the turn in the proper lane.
- **Red light and crosswalk.** Read the lamp from `signal_detail` when it is small in the wide view. Treat an unreadable light as unknown and confirm it at the line. Report a change only when two readable frames establish it. At steady red, stop fully before the line. A posted NO TURN ON RED requires waiting until the signal permits the turn. Where permitted, a right on red requires a full stop and yielding. A left on red is limited to one-way street to one-way street where permitted, with the same stop and yield duties. After a light or traffic conflict changes, take a fresh turn-side view. If a pedestrian is near the stripe edge, use the detail view to locate their feet and identify whether their path intersects your turn. Hold until the crosswalk and intended lane are clearly free. Yield to pedestrians even on green.

The current route and controls come from observation. `drive_wait` holds at your present stop until the observed conflict changes. Confirm `lesson.passed` and zero speed before reporting that you finished. The rules above follow the Massachusetts RMV Driver's Manual, chapter 4.

## Night driving

Use `drive_headlights` to select low or high beam. Use high beams on dark roads with enough separation. Switch to low within 500 feet of oncoming traffic or 200 feet of a vehicle ahead. `drive_brake` holds the brake and illuminates the red stop lights until you drive again.

## Free drive

Use `drive_gas` for a distance or the left/right tools for relative steering. Bounded moves stop before returning. A turn defaults to 10°. Equal opposite angles restore the original heading. Use `drive_brake` for an explicit stop. At the yield junction follow `crossing.next`. Approach the line, yield while stopped, then cross and park. Confirm `crossing.status: past` and zero speed. Exit only while stationary.
