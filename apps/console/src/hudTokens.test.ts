import { describe, expect, it } from "vitest";
// @ts-ignore -- the app tsconfig has no node types, and vitest empties CSS imports
import { readFileSync } from "node:fs";

// Reads the shipped CSS so a changed token cannot pass against a stale copy.
const css: string = readFileSync("src/index.css", "utf8");
const token = (name: string) => {
  const value = css.match(new RegExp(`${name}:\\s*([^;]+);`))?.[1].trim();
  if (!value) throw new Error(`missing token ${name}`);
  return value;
};
const hex = (v: string) => [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
const luminance = (rgb: number[]) => {
  const [r, g, b] = rgb.map((c) => c / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

describe("HUD text tokens", () => {
  // Worst case: the translucent panel over pure white.
  const [r, g, b, a] = token("--hud-panel").match(/[\d.]+/g)!.map(Number);
  const panel = luminance([r, g, b].map((c) => a * c + (1 - a) * 255));

  it.each(["--hud-text", "--hud-dim", "--hud-energy", "--hud-energy-low", "--hud-energy-out", "--hud-xp", "--hud-other"])(
    "%s reads at 4.5:1 or better",
    (name) => {
      const l = luminance(hex(token(name)));
      expect((Math.max(l, panel) + 0.05) / (Math.min(l, panel) + 0.05)).toBeGreaterThanOrEqual(4.5);
    },
  );
});
