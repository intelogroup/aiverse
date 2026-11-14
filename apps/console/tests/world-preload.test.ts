import { describe, expect, it } from "vitest";
import { worldPreloadScript, worldPreloadUrls } from "../worldPreload";

const tex = ["/assets/tiles/tex/3efeaaf0133ec046.ktx2", "/assets/tiles/tex/168312d512f3e6a2.ktx2"];

describe("worldPreloadUrls", () => {
  it("lists the core files, the transcoder and the core's KTX2 textures for a tiles build", () => {
    const urls = worldPreloadUrls({ tiles: true, coreTextures: tex });
    expect(urls).toEqual(expect.arrayContaining(["/assets/tiles/core.glb", "/assets/tiles/districts.json", "/assets/tiles/core.col.glb", "/basis/basis_transcoder.js", "/basis/basis_transcoder.wasm", ...tex]));
    expect(urls).toHaveLength(5 + tex.length);
  });
  it("is empty without tiles (a build without the tile step must inject nothing)", () => {
    expect(worldPreloadUrls(null)).toEqual([]);
    expect(worldPreloadUrls({})).toEqual([]);
    expect(worldPreloadUrls({ tiles: false, coreTextures: tex })).toEqual([]);
  });
  it("tolerates an old manifest with no coreTextures", () => {
    expect(worldPreloadUrls({ tiles: true })).toHaveLength(5);
  });
  it("drops anything that is not a content-hashed tile texture (the list lands in inline JS)", () => {
    const urls = worldPreloadUrls({ tiles: true, coreTextures: [...tex, "/assets/tiles/tex/../../secret.ktx2", "https://evil.example/x.ktx2", 7, '"});alert(1);//', "/assets/tiles/tex/zz.ktx2"] });
    expect(urls.filter((u) => u.includes("tex/"))).toEqual(tex);
  });
});

describe("worldPreloadScript", () => {
  it("is empty when there is nothing to preload", () => {
    expect(worldPreloadScript({ tiles: false })).toBe("");
  });
  it("injects preload links with the loaders' cors mode, only on world routes", () => {
    const js = worldPreloadScript({ tiles: true, coreTextures: tex });
    expect(js).toContain('l.rel="preload"');
    expect(js).toContain('l.as="fetch"');
    expect(js).toContain('l.crossOrigin="anonymous"');
    for (const u of tex) expect(js).toContain(u);
    const run = (path: string, search = "") => {
      const links: Record<string, unknown>[] = [];
      const doc = { createElement: () => ({}) as Record<string, unknown>, head: { appendChild: (l: Record<string, unknown>) => links.push(l) } };
      new Function("location", "document", js)({ pathname: path, search }, doc);
      return links;
    };
    expect(run("/").length).toBe(5 + tex.length);
    expect(run("/?walk=1").length).toBe(5 + tex.length);
    for (const p of ["/docs", "/docs/x", "/public/y", "/verse", "/claim", "/oauth/consent", "/verify-email", "/reset-password"]) expect(run(p)).toEqual([]);
    expect(run("/", "?tiles=0")).toEqual([]);
    expect(run("/", "?a=1&tiles=0")).toEqual([]);
  });
});
