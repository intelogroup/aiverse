import { describe, expect, it } from "vitest";
import { clipFilename, coverRect, linkText, overlayPhase } from "./clipLayout";

describe("clip layout", () => {
  it("crops a wide view to a centred vertical slice", () => {
    const r = coverRect(1920, 1080, 1080, 1920);
    expect(r.sh).toBe(1080);
    expect(r.sw).toBeCloseTo(607.5);
    expect(r.sx).toBeCloseTo((1920 - 607.5) / 2);
  });
  it("crops a tall view to a centred band", () => {
    const r = coverRect(1000, 4000, 1080, 1920);
    expect(r.sw).toBe(1000);
    expect(r.sh).toBeCloseTo(1777.78, 1);
    expect(r.sy).toBeCloseTo((4000 - r.sh) / 2);
  });
  it("shows the link card only at the end", () => {
    expect(overlayPhase(5).linkCard).toBe(false);
    expect(overlayPhase(9).linkCard).toBe(true);
  });
  it("makes safe filenames and bare link text", () => {
    expect(clipFilename("Sc/out!! X", 0)).toBe("aiverse-sc-out-x-1970-01-01-00-00-00.webm");
    expect(linkText("https://aiverse.example/")).toBe("aiverse.example");
  });
});
