import { describe, expect, it } from "vitest";
import { resolveAssetUrl, resolveManifestAssets } from "./assetUrl";

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

describe("resolveManifestAssets", () => {
  it("resolves district url/collisionUrl plus links and shell, keeps the rest", () => {
    const m = {
      links: "/assets/world-city3.glb",
      shell: "/assets/world-shell.glb",
      themes: { bazaar: { night: 0 } },
      districts: [
        { id: "bazaar", url: "/assets/world-city3.glb", collisionUrl: "/assets/world-city3-collision.glb" },
        { id: "far", url: "/assets/world-far.glb" },
      ],
    };
    const out = resolveManifestAssets(m);
    expect(out.links).toMatch(/\.r2\.dev\/glbs\/[0-9a-f]{16}\/world-city3\.glb$/);
    expect(out.districts[0].url).toMatch(/\.r2\.dev\/glbs\/[0-9a-f]{16}\/world-city3\.glb$/);
    expect(out.districts[0].collisionUrl).toMatch(/\.r2\.dev\/glbs\/[0-9a-f]{16}\/world-city3-collision\.glb$/);
    expect(out.districts[1].url).toBe("/assets/world-far.glb");
    expect(out.districts[1].collisionUrl).toBeUndefined();
    expect(out.themes).toBe(m.themes);
  });
});
