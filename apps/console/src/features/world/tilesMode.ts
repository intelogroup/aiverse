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
 * JS is requestable up front. The build (vite.config.ts `worldPreload`, worldPreload.ts) injects <link rel=preload> for the core
 * GLB, manifest, core collision, the KTX2 transcoder and the core's KTX2 textures into index.html, so they download from the
 * first byte, in parallel, on world routes. (They used to be added here, once this module ran, and only with ?walk.)
 */
