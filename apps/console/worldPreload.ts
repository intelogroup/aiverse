/**
 * Build-time <link rel=preload> tags for the world's critical path (tile mode).
 *
 * The core tile, its manifest, its collision, the KTX2 transcoder and the core's KTX2 textures were only requested once the world's
 * JS chunk had run (tilesMode.ts) and, for the textures, only after core.glb had parsed (deferTextures.ts afterRoot): on a phone the
 * plaza sat gray for seconds. Everything here is known at build time, so index.html can ask for all of it at the first byte.
 *
 * crossorigin="anonymous": the loaders (GLTF/KTX2 FileLoader) fetch in cors mode without credentials; a preload with another mode
 * would not be reused by the browser's cache and the file would download twice.
 */
export interface WorldManifestLike { tiles?: boolean; coreTextures?: unknown }

const CORE_FILES = ["/assets/tiles/core.glb", "/assets/tiles/districts.json", "/assets/tiles/core.col.glb", "/basis/basis_transcoder.js", "/basis/basis_transcoder.wasm"];
/** Routes that are not the world (App.tsx picks these by pathname prefix); they must never pay for the world's preloads. */
const NON_WORLD = "^\\/(docs|public|verse|claim|oauth|verify-email|reset-password)"; // used inside a regex literal: the slash is escaped
const SAFE_TEXTURE = /^\/assets\/tiles\/tex\/[0-9a-f]{16}\.ktx2$/;

/** The URLs to preload for this manifest; empty when the build has no tiles. */
export function worldPreloadUrls(manifest: WorldManifestLike | null | undefined): string[] {
  if (!manifest || manifest.tiles !== true) return [];
  const tex = Array.isArray(manifest.coreTextures) ? manifest.coreTextures.filter((u): u is string => typeof u === "string" && SAFE_TEXTURE.test(u)) : [];
  return [...CORE_FILES, ...tex];
}

/** An inline script that injects the preload links, only on world routes (and only when ?tiles is not 0). Empty string = nothing to inject. */
export function worldPreloadScript(manifest: WorldManifestLike | null | undefined): string {
  const urls = worldPreloadUrls(manifest);
  if (urls.length === 0) return "";
  return `(function(){var p=location.pathname;if(/${NON_WORLD}/.test(p)||/[?&]tiles=0(&|$)/.test(location.search))return;${JSON.stringify(urls)}.forEach(function(h){var l=document.createElement("link");l.rel="preload";l.as="fetch";l.crossOrigin="anonymous";l.href=h;document.head.appendChild(l)})})();`;
}
