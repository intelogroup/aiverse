/**
 * World tiles switch (phone-load plan, option B): the Bazaar streams from apps/console/public/assets/tiles/ (a small core on the
 * fountain first, the rest by distance) instead of the one 91 MB world GLB. On by default in builds that contain the tiles
 * (vite.config.ts `__TILES_DEFAULT__`); `?tiles=0` forces the one-file world, `?tiles=1` forces tiles.
 */
export function tilesEnabled(search: string, buildDefault: boolean): boolean {
  const v = new URLSearchParams(search).get("tiles");
  return v === null ? buildDefault : v !== "0";
}
export const TILES: boolean = typeof window !== "undefined" && tilesEnabled(window.location.search, __TILES_DEFAULT__);
/** Stable alias of the core tile, so the page can preload it before the manifest (with its content-hashed name) is known. */
export const CORE_TILE_URL = "/assets/tiles/core.glb";

/**
 * The tile path is a chain: JS -> core GLB -> (Suspense resolves) -> manifest -> core collision -> walkable. Everything after the
 * JS is requestable up front, so start it at module load rather than after the previous link finished: the manifest and the
 * core collision used to be asked for only once the core had rendered (5.9 s on the emulated phone, 0.3 s of data).
 */
// This module is only evaluated with the lazily loaded world chunk (WorldView), so any page that evaluates it is about to
// draw the world, including the homepage (it IS the world view). Gating this on ?walk left `/` waiting for the transcoder
// until the first texture asked for it (~7 s on the emulated phone, while the whole world sat gray).
if (TILES && typeof document !== "undefined") {
  const preload = (href: string) => { const l = document.createElement("link"); l.rel = "preload"; l.as = "fetch"; l.crossOrigin = "anonymous"; l.href = href; document.head.appendChild(l); };
  [CORE_TILE_URL, "/assets/tiles/districts.json", "/assets/tiles/core.col.glb", "/basis/basis_transcoder.js", "/basis/basis_transcoder.wasm"].forEach(preload);
}
