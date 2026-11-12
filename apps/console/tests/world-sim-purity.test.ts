// @vitest-environment node
// packages/world-sim is the part of City 3 that also runs on the server (the agent sim): no React, no DOM, no
// browser globals, no reaching back into the console. This is the guard that keeps it that way; the console keeps a
// one-line shim at each old path (src/features/world/<name>.ts) so its imports and tests are unchanged.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pkg = new URL("../../../packages/world-sim/src/", import.meta.url);
const shims = new URL("../src/features/world/", import.meta.url);
const names = readdirSync(pkg).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => f.slice(0, -3)).sort();

/** Source without comments, so a doc comment that mentions "window" or "document" is not a violation. */
function code(name: string): string {
  return readFileSync(new URL(`${name}.ts`, pkg), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}
const specifiers = (src: string) => [...src.matchAll(/(?:from|import)\s*["']([^"']+)["']/g)].map((m) => m[1]);

// recast-navigation is the Recast/Detour WASM (cityNav.ts): no DOM, runs in Node and Bun as in the browser.
/** Package-only modules: the console never had them, so they have no shim. look/png are the agent's depth/class image (png.ts encodes with node:zlib). */
const SERVER_ONLY = new Set(["agentBody", "verseSim", "actionProtocol", "worldService", "look", "png"]);
const ALLOWED_EXTERNAL = new Set(["three", "three-mesh-bvh", "recast-navigation", "@recast-navigation/core"]);
const BROWSER_GLOBALS = /\b(window|document|navigator|localStorage|sessionStorage|AudioContext|HTMLElement|requestAnimationFrame|location|OffscreenCanvas)\b/;

describe("packages/world-sim stays pure", () => {
  it("has modules (the guard is not vacuous)", () => {
    expect(names.length).toBeGreaterThanOrEqual(15);
  });

  it.each(names)("%s imports only the package itself, three, three-mesh-bvh and recast-navigation", (name) => {
    for (const spec of specifiers(code(name))) {
      if (spec.startsWith("./")) {
        expect(existsSync(new URL(`${spec.slice(2)}.ts`, pkg)), `${name}: ${spec} must exist inside the package`).toBe(true);
      } else if (spec.startsWith("three/")) {
        // type-only helpers of three are fine; addons that touch the DOM (loaders, controls) are not
        expect(spec, `${name}: only plain three is allowed`).toBe("three");
      } else {
        // SERVER_ONLY modules never run in the browser (no console shim —
        // worldService & friends live in the sim/gateway), so node:
        // builtins are not a portability leak for them. worldService's
        // node:crypto (HMAC body handles, PR #117) tripped this guard on
        // main: the import is deliberate and server-side. Browser-portable
        // modules keep the strict allowlist unchanged.
        const serverBuiltin = SERVER_ONLY.has(name) && spec.startsWith("node:");
        expect(ALLOWED_EXTERNAL.has(spec) || spec.startsWith("@aiverse/world-sim/") || serverBuiltin, `${name}: forbidden import "${spec}"`).toBe(true);
      }
    }
  });

  it.each(names)("%s touches no browser global", (name) => {
    const hit = code(name).match(BROWSER_GLOBALS);
    expect(hit?.[0] ?? null, `${name} uses the browser global "${hit?.[0]}"`).toBeNull();
  });

  it.each(names.filter((n) => !SERVER_ONLY.has(n)))("the console shim for %s re-exports the package module", (name) => {
    const shim = new URL(`${name}.ts`, shims);
    expect(existsSync(shim), `missing shim ${name}.ts`).toBe(true);
    expect(readFileSync(shim, "utf8").trim()).toBe(`export * from "@aiverse/world-sim/${name}";`);
  });
});
