/**
 * Sensorium guard — the L3/L4 leak closures, made structural.
 *
 * The leak audit (Sensorium Charter) found the experimenter-truth
 * surfaces in the rig lineage: __scout.look() returning per-egg verdicts
 * (view.eggs[]) and the truth globals window.__eggs / __truth /
 * __patrolTruth on the same window the agent APIs live on. Live main
 * never carried them; this test keeps it that way. A leak that can only
 * exist by convention stays fixed-pending forever — a leak the build
 * rejects is closed.
 *
 * Rules enforced over every .ts/.tsx source under src/ (loaded as raw
 * text via import.meta.glob, so the scan covers exactly what ships):
 *  1. The banned truth-surface names appear nowhere.
 *  2. The set of window.__* globals assigned anywhere in src/ equals the
 *     recorded allowlist exactly — a new global fails the suite until it
 *     is reviewed and recorded here with its reason, and a renamed or
 *     removed one fails too (the list stays honest in both directions).
 *  3. ScoutAgent's look() keeps its frames + object-list contract and
 *     gains no verdict payload (the `view:` key the rig lineage added).
 */
import { describe, expect, it } from "vitest";

const SOURCES = import.meta.glob("/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const SELF = "/src/features/world/sensorium.test.ts";
const SCOUT = "/src/features/world/ScoutAgent.tsx";
const FILES = Object.entries(SOURCES).filter(([p]) => p !== SELF);

/** window.__name -> why this global is a legitimate agent/debug surface. */
const KNOWN_GLOBALS: Record<string, string> = {
  __scout: "the Agent A API itself (ScoutAgent) — frames + object list, no truth",
  __walk: "walker debug handle, ?walkDebug=1 only (CityWalker)",
  __districts: "district streaming state for the console UI (DistrictWorld)",
  __city3Stream: "streaming debug handle, ?streamDebug=1 only (GlbWorld)",
  __sound: "sound director / PA debug surface (GlbWorld)",
  __tts: "plaza speech debug surface (GlbWorld)",
  __quality: "quality governor debug handle, ?qualityDebug=1 only (GlbWorld)",
  __bartender: "Tea House bartender scene handle (TeaBartender)",
  __elevator: "Tea House elevator view handle, ?walkDebug (TeaElevatorView)",
  __footlock: "production foot-lock self-check surface (footLock)",
};

const BANNED = ["__eggs", "__truth", "__patrolTruth", "viewEggs"];

describe("sensorium guard (leak-audit L3/L4 closure)", () => {
  it("scans a real source tree", () => {
    // A guard that scans nothing proves nothing.
    expect(FILES.length).toBeGreaterThan(50);
    expect(SOURCES[SCOUT]).toBeTypeOf("string");
  });

  it("no truth-surface names anywhere in src/", () => {
    for (const [path, text] of FILES) {
      for (const name of BANNED) {
        expect(text.includes(name), `${path} contains banned ${name}`).toBe(false);
      }
    }
  });

  it("window globals match the recorded allowlist exactly", () => {
    const found = new Set<string>();
    // The three assignment shapes used in this codebase:
    //   (window as unknown as ...).__name = ...   (cast form)
    //   window.__name = ...                       (direct form)
    //   w.__name = ...                            (the conventional
    //     `const w = window as ...` alias — used only for window here)
    // plus the bracket form window["__name"] = ...
    const shapes = [
      /\(\s*window\b[\s\S]{0,160}?\)\s*\.\s*(__\w+)\s*=(?!=)/g,
      /\b(?:window|globalThis)\s*\.\s*(__\w+)\s*=(?!=)/g,
      /\bw\s*\.\s*(__\w+)\s*=(?!=)/g,
      /\[\s*["'](__\w+)["']\s*\]\s*=(?!=)/g,
    ];
    for (const [, text] of FILES) {
      for (const re of shapes) {
        for (const m of text.matchAll(re)) found.add(m[1]);
      }
    }
    expect([...found].sort()).toEqual(Object.keys(KNOWN_GLOBALS).sort());
  });

  it("__scout.look() returns frames + scene, never a verdict payload", () => {
    const scout = SOURCES[SCOUT];
    expect(scout).toMatch(
      /look:\s*\(\)\s*=>\s*Promise<\{\s*image:[^}]*scene:\s*OracleObject\[\]/,
    );
    expect(scout).not.toMatch(/[{,]\s*view\s*:/);
  });
});
