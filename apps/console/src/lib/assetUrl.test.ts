import { describe, expect, it, vi } from "vitest";
import { DEFAULT_ASSET_BASE, defaultAssetBase, resolveAssetUrl } from "./assetUrl";

const BASE = "https://pub-example.r2.dev";
const MAP = {
  "world-city3.glb": "glbs/0123456789abcdef/world-city3.glb",
  "mira-maid.glb": "glbs/fedcba9876543210/mira-maid.glb",
};

describe("resolveAssetUrl", () => {
  it("maps a staged top-level GLB to its content-hashed R2 URL", () => {
    expect(resolveAssetUrl("/assets/world-city3.glb", BASE, MAP)).toBe(
      "https://pub-example.r2.dev/glbs/0123456789abcdef/world-city3.glb",
    );
  });

  it("maps a staged GLB in a subdirectory by basename", () => {
    expect(resolveAssetUrl("/assets/residents/mira-maid.glb", BASE, MAP)).toBe(
      "https://pub-example.r2.dev/glbs/fedcba9876543210/mira-maid.glb",
    );
  });

  it("leaves unstaged assets on the local path", () => {
    expect(resolveAssetUrl("/assets/catalog/untitled.glb", BASE, MAP)).toBe("/assets/catalog/untitled.glb");
  });

  it("leaves non-GLB data files local even when a same-name key existed", () => {
    expect(resolveAssetUrl("/assets/districts.json", BASE, MAP)).toBe("/assets/districts.json");
  });

  it("passes absolute URLs through unchanged (idempotent)", () => {
    const abs = "https://pub-example.r2.dev/glbs/0123456789abcdef/world-city3.glb";
    expect(resolveAssetUrl(abs, BASE, MAP)).toBe(abs);
  });

  it("empty base disables R2 delivery (the config flip back)", () => {
    expect(resolveAssetUrl("/assets/world-city3.glb", "", MAP)).toBe("/assets/world-city3.glb");
  });
});

describe("defaultAssetBase", () => {
  it("keeps a dev server on local assets, which the R2 bucket CORS-blocks", () => {
    expect(defaultAssetBase(true)).toBe("");
  });

  it("keeps production on the content-hashed bucket", () => {
    expect(defaultAssetBase(false)).toBe(DEFAULT_ASSET_BASE);
  });
});

/** Module-level ASSET_BASE is read at import time, so each mode gets a fresh module graph. */
async function withBase<T>(base: string | undefined, fn: (m: typeof import("./assetUrl")) => T): Promise<T> {
  vi.resetModules();
  if (base === undefined) vi.stubEnv("VITE_ASSET_BASE", undefined as unknown as string);
  else vi.stubEnv("VITE_ASSET_BASE", base);
  try {
    return fn(await import("./assetUrl"));
  } finally {
    vi.unstubAllEnvs();
    vi.resetModules();
  }
}

describe("resolveManifestAssets", () => {
  const manifest = () => ({
    links: "/assets/world-links.glb",
    shell: "/assets/world-shell.glb",
    themes: { bazaar: { night: 0 } },
    districts: [
      { id: "bazaar", url: "/assets/world-city3-library.glb", collisionUrl: "/assets/world-city3-collision.glb" },
      { id: "far", url: "/assets/world-far.glb", farUrl: "/assets/houses/american-y0.far.glb" },
    ],
  });

  it("resolves district url/collisionUrl plus links and shell, keeps the rest", async () => {
    await withBase(BASE, (m) => {
      const input = manifest();
      const out = m.resolveManifestAssets(input);
      expect(out.links).toMatch(/pub-example\.r2\.dev\/glbs\/[0-9a-f]{16}\/world-links\.glb$/);
      expect(out.districts[0].url).toMatch(/pub-example\.r2\.dev\/glbs\/[0-9a-f]{16}\/world-city3-library\.glb$/);
      expect(out.districts[0].collisionUrl).toMatch(/pub-example\.r2\.dev\/glbs\/[0-9a-f]{16}\/world-city3-collision\.glb$/);
      expect(out.districts[1].url).toBe("/assets/world-far.glb");       // unstaged stays local
      expect(out.districts[1].farUrl).toMatch(/pub-example\.r2\.dev\/glbs\/[0-9a-f]{16}\/american-y0\.far\.glb$/);
      expect(out.districts[1].collisionUrl).toBeUndefined();
      expect(out.themes).toBe(input.themes);
    });
  });

  it("serves the monolithic world GLB from its content-hashed R2 path", async () => {
    await withBase(BASE, (m) => {
      const out = m.resolveManifestAssets({ districts: [{ id: "bazaar", url: "/assets/world-city3.glb" }] });
      expect(out.districts[0].url).toMatch(/pub-example\.r2\.dev\/glbs\/[0-9a-f]{16}\/world-city3\.glb$/);
    });
  });

  it("leaves every asset local when no base is configured (the dev default)", async () => {
    await withBase("", (m) => {
      const input = manifest();
      const out = m.resolveManifestAssets(input);
      expect(out.links).toBe("/assets/world-links.glb");
      expect(out.shell).toBe("/assets/world-shell.glb");
      expect(out.districts[0].url).toBe("/assets/world-city3-library.glb");
      expect(out.districts[0].collisionUrl).toBe("/assets/world-city3-collision.glb");
      expect(out.districts[1].farUrl).toBe("/assets/houses/american-y0.far.glb");
    });
  });
});
