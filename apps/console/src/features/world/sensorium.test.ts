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
 *     The set is computed STRUCTURALLY: each source is parsed with the
 *     TypeScript compiler and element-access keys are resolved through
 *     their bindings (literals, conditionals, identifier chains). The
 *     original regex scan could not see production's ScoutAgent, which
 *     assigns through a computed key —
 *       const key = primary ? "__scout" : "__scoutPeer"; w[key] = api;
 *     — so it certified a set the code never actually produced. The
 *     AST enumeration is the technique proven by the border test
 *     suite's surface enumerator (experiments/border/).
 *  3. ScoutAgent's look() keeps its frames + object-list contract and
 *     gains no verdict payload (the `view:` key the rig lineage added).
 */
import { describe, expect, it } from "vitest";
import ts from "typescript";

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
  __scoutPeer:
    "the peer-agent API (ScoutAgent, non-primary instance) — same frames + object list contract as __scout, no truth; declared after the border suite's enumeration surfaced it (2026-11-09)",
  __walk: "walker debug handle, ?walkDebug=1 only (CityWalker)",
  __districts: "district streaming state for the console UI (DistrictWorld)",
  __city3Stream: "streaming debug handle, ?streamDebug=1 only (GlbWorld)",
  __sound: "sound director / PA debug surface (GlbWorld)",
  __tts: "plaza speech debug surface (GlbWorld)",
  __quality: "quality governor debug handle, ?qualityDebug=1 only (GlbWorld)",
  __bartender: "Tea House bartender scene handle (TeaBartender)",
  __elevator: "Tea House elevator view handle, ?walkDebug (TeaElevatorView)",
  __footlock: "production foot-lock self-check surface (footLock)",
  __AIVERSE_BUILD_SHA__:
    "build SHA stamp published for telemetry/session records (lib/telemetry)",
  __aiverseTelemetry:
    "telemetry black-box surface: session log + export + error capture, no world truth (lib/telemetry)",
  __aiverseTelemetryAttached:
    "idempotence marker set when the world renderer attaches telemetry (lib/telemetry)",
};

const BANNED = ["__eggs", "__truth", "__patrolTruth", "viewEggs"];

/**
 * The set of window.__* globals a source file assigns, computed from
 * its TypeScript AST. Handles the assignment shapes this codebase
 * uses — direct (`window.__x =`), cast (`(window as ...).__x =`),
 * aliased (`const w = window as ...; w.__x =`), bracket-literal
 * (`w["__x"] =`), and computed keys resolved through their bindings
 * (`const key = cond ? "__a" : "__b"; w[key] =` yields BOTH names —
 * either can land on the window at runtime, so both are surfaces).
 */
function windowGlobalsAssigned(text: string, path: string): Set<string> {
  const sf = ts.createSourceFile(
    path,
    text,
    ts.ScriptTarget.Latest,
    true,
    path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  // name -> initializer, for every plain variable declaration.
  const bindings = new Map<string, ts.Node>();
  const collect = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      bindings.set(n.name.text, n.initializer);
    }
    n.forEachChild(collect);
  };
  collect(sf);

  const unwrap = (n: ts.Node): ts.Node => {
    while (
      ts.isAsExpression(n) ||
      ts.isTypeAssertionExpression(n) ||
      ts.isParenthesizedExpression(n)
    ) {
      n = n.expression;
    }
    return n;
  };

  // Identifiers that denote the window: window/globalThis themselves,
  // plus any variable bound to one of them — through casts, or through
  // a conditional with a window arm (DistrictWorld binds its alias as
  // `typeof window !== "undefined" ? (window as ...) : null`; the
  // variable can hold the window at runtime, so it is an alias).
  const aliases = new Set(["window", "globalThis"]);
  const resolvesToWindow = (n: ts.Node, depth = 0): boolean => {
    if (!n || depth > 8) return false;
    const u = unwrap(n);
    if (ts.isIdentifier(u)) return aliases.has(u.text);
    if (ts.isConditionalExpression(u)) {
      return (
        resolvesToWindow(u.whenTrue, depth + 1) ||
        resolvesToWindow(u.whenFalse, depth + 1)
      );
    }
    return false;
  };
  for (const [name, init] of bindings) {
    if (resolvesToWindow(init)) aliases.add(name);
  }
  const isWindow = (n: ts.Node): boolean => {
    const u = unwrap(n);
    return ts.isIdentifier(u) && aliases.has(u.text);
  };

  // Every string literal an expression can evaluate to, resolving
  // identifiers through bindings and taking both conditional arms.
  const resolveStrings = (node: ts.Node, depth = 0): Set<string> => {
    const out = new Set<string>();
    if (!node || depth > 8) return out;
    if (ts.isStringLiteral(node)) {
      out.add(node.text);
    } else if (ts.isParenthesizedExpression(node)) {
      for (const s of resolveStrings(node.expression, depth + 1)) out.add(s);
    } else if (ts.isConditionalExpression(node)) {
      for (const s of resolveStrings(node.whenTrue, depth + 1)) out.add(s);
      for (const s of resolveStrings(node.whenFalse, depth + 1)) out.add(s);
    } else if (ts.isIdentifier(node) && bindings.has(node.text)) {
      for (const s of resolveStrings(bindings.get(node.text)!, depth + 1)) out.add(s);
    }
    return out;
  };

  const found = new Set<string>();
  const walk = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const L = n.left;
      if (ts.isPropertyAccessExpression(L) && isWindow(L.expression)) {
        if (L.name.text.startsWith("__")) found.add(L.name.text);
      } else if (ts.isElementAccessExpression(L) && isWindow(L.expression)) {
        for (const s of resolveStrings(L.argumentExpression)) {
          if (s.startsWith("__")) found.add(s);
        }
      }
    }
    n.forEachChild(walk);
  };
  walk(sf);
  return found;
}

// --- positive-control fixtures -------------------------------------
// The guard is only worth anything if it provably FIRES. These two
// fixtures pin the enumeration's sensitivity: the production shape
// (computed key, both arms) must resolve, and planted unlisted
// globals — literal-bracket and computed-key alike — must surface,
// so the allowlist equality check would fail on them.

const DYNAMIC_KEY_FIXTURE = `
  const api = { look: async () => ({ image: null, scene: [] }) };
  export function installScout(primary: boolean) {
    const w = window as unknown as Record<string, unknown>;
    const key = primary ? "__scout" : "__scoutPeer";
    w[key] = api;
    return () => { if (w[key] === api) delete w[key]; };
  }
`;

const PLANTED_FIXTURE = `
  const w = window as unknown as Record<string, unknown>;
  w["__plantedTruth"] = { eggs: [] };
  const k = "__sneakyGlobal";
  w[k] = 1;
`;

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

  it("enumeration resolves computed keys (production ScoutAgent shape)", () => {
    const found = windowGlobalsAssigned(DYNAMIC_KEY_FIXTURE, "fixture.tsx");
    expect([...found].sort()).toEqual(["__scout", "__scoutPeer"]);
  });

  it("enumeration surfaces planted unlisted globals (the guard fires)", () => {
    const found = windowGlobalsAssigned(PLANTED_FIXTURE, "fixture.ts");
    expect(found.has("__plantedTruth")).toBe(true);
    expect(found.has("__sneakyGlobal")).toBe(true);
    // Neither is recorded, so the equality check below would fail on
    // a tree containing this fixture — that failure is the control.
    expect(Object.keys(KNOWN_GLOBALS)).not.toContain("__plantedTruth");
    expect(Object.keys(KNOWN_GLOBALS)).not.toContain("__sneakyGlobal");
    expect([...found].sort()).not.toEqual(Object.keys(KNOWN_GLOBALS).sort());
  });

  it("window globals match the recorded allowlist exactly", () => {
    const found = new Set<string>();
    for (const [path, text] of FILES) {
      for (const name of windowGlobalsAssigned(text, path)) found.add(name);
    }
    expect([...found].sort()).toEqual(Object.keys(KNOWN_GLOBALS).sort());
  }, 60_000);

  it("__scout.look() returns frames + scene, never a verdict payload", () => {
    const scout = SOURCES[SCOUT];
    expect(scout).toMatch(
      /look:\s*\(\)\s*=>\s*Promise<\{\s*image:[^}]*scene:\s*OracleObject\[\]/,
    );
    expect(scout).not.toMatch(/[{,]\s*view\s*:/);
  });
});
