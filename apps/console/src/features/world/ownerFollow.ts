// ownerFollow.ts — "land on my agent": which streamed body is the signed-in owner's, and where the follow camera goes.
// Pure (no React, no three) so it is unit tested. The public stream carries a display name and a body number, never an agent id or
// owner (frames.ts), so the owner's body is matched by NAME against the names from GET /owners/agents. Agent names are unique, and
// the name is already public on the roster, so this leaks nothing new.
import { followTarget, type Vec3 } from "./cameraRig";
import type { RemotePose } from "@aiverse/world-sim/streamProtocol";

export interface RosterBody { n: number; name: string }

/**
 * The owner's body to follow: among the roster bodies whose name is one of the owner's agents, the NEWEST attached (the sim numbers
 * bodies in attach order, so the highest n). Null when none of the owner's agents has a body now.
 */
export function pickOwnBody(list: readonly RosterBody[], ownerNames: readonly string[]): RosterBody | null {
  if (ownerNames.length === 0) return null;
  const mine = new Set(ownerNames);
  let best: RosterBody | null = null;
  for (const b of list) if (mine.has(b.name) && (!best || b.n > best.n)) best = b;
  return best;
}

/** Trail pose (camera + gaze point) for a streamed pose: the same framing the Follow button uses on a local bot. */
export function ownFollowPose(p: Pick<RemotePose, "x" | "y" | "z" | "heading">): { cam: Vec3; look: Vec3 } {
  return followTarget({ x: p.x, z: p.z, heading: p.heading, feetY: p.y, seated: false });
}
