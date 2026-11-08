import { describe, expect, it } from "vitest";
import { angleDelta } from "./embody";

// What remains of the Embody v0 spike's test surface: the skill-layer
// suites (EmbodyController skills, the sit choreography, the deck
// composition, the crowd control surface) left with the controller and
// the Agora deck it drove (2026-11-08). The heading math is shared with
// cameraRig.ts and stays covered here.
describe("heading math", () => {
  it("angleDelta takes the short way around the circle", () => {
    expect(angleDelta(0, Math.PI)).toBeCloseTo(Math.PI);
    expect(angleDelta((3 * Math.PI) / 4, (-3 * Math.PI) / 4)).toBeCloseTo(Math.PI / 2);
    expect(angleDelta(0, -Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
  });
});
