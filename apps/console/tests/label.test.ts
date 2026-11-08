// @vitest-environment node
// Deletion guard (2026-11-08, Jim's order): NO character anywhere in
// the product renders a floating name label. The CastFigure nameplate
// (drei Html leader-line callout) and every label feed into it were
// deleted with the Agora; these source-level checks pin the absence
// so the plates cannot quietly come back. Lives outside src/ like
// glb-inventory.test.ts (browser-typed tsconfig in there).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const figure = readFileSync(new URL("../src/features/world/CastFigure.tsx", import.meta.url), "utf8");
const scout = readFileSync(new URL("../src/features/world/ScoutAgent.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/features/world/world.css", import.meta.url), "utf8");

describe("no floating name labels anywhere", () => {
  it("CastFigure carries no nameplate machinery", () => {
    expect(figure).not.toContain("NameSprite");
    expect(figure).not.toContain("NAMEPLATE");
    expect(figure).not.toContain("spriteTag");
    expect(figure).not.toContain("w-cast-name");
    expect(figure).not.toContain("Html");
  });

  it("no caller feeds a label to a figure", () => {
    expect(scout).not.toContain("label=");
  });

  it("the nameplate styles are gone", () => {
    expect(css).not.toContain(".w-cast-name");
    expect(css).not.toContain(".w-cast-tag");
  });
});
