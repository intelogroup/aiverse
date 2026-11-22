import { describe, expect, it } from "vitest";
import castFigureSrc from "./CastFigure.tsx?raw";
import { BODIES } from "./bodies";

// Guard (2026-11-22): a quality-tier change must never fetch or swap a character model. On a real iPhone the lite swap fetched two
// bigger files (12.9 + 12.2 MB vs 9.2 + 9.4 MB) mid-session and the page stalled 6.0 s + 1.9 s (?perf=1 log). Tiers move resolution and
// shadows only.
describe("character models do not depend on the quality tier", () => {
  it("CastFigure loads body.url and never reads the quality store", () => {
    expect(castFigureSrc).not.toMatch(/liteUrl/);
    expect(castFigureSrc).not.toMatch(/qualityStore|useSyncExternalStore/);
    expect(castFigureSrc).toMatch(/useGLTF\(assetUrl\(body\.url\)/);
  });
  it("no body declares a lite variant", () => {
    for (const b of Object.values(BODIES)) expect("liteUrl" in b, b.id).toBe(false);
  });
});
