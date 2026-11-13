/**
 * Asset delivery resolver — world/body GLBs are staged in the R2
 * `verse-assets` bucket under content-hashed keys
 * (`glbs/<sha256[0:16]>/<basename>`, see staged-assets.json) and served with
 * `Cache-Control: public, max-age=31536000, immutable`. When an asset base
 * is configured and the file is staged, loads go to R2; anything else keeps
 * its local `/assets/...` path (the repo files never move, so the Vercel
 * fallback is always intact) and non-GLB data (districts.json, interiors,
 * places) always stays local.
 *
 * Flip back to local-only: build with `VITE_ASSET_BASE=""`. The service
 * worker (public/sw.js) cache-firsts exactly the R2 URLs produced here.
 */
import staged from "./staged-assets.json";

export const DEFAULT_ASSET_BASE = "https://verse.clixen.app";

const rawBase = import.meta.env.VITE_ASSET_BASE as string | undefined;
/** "" disables R2 delivery entirely; undefined falls back to the default bucket. */
export const ASSET_BASE = rawBase === undefined ? DEFAULT_ASSET_BASE : rawBase;

const STAGED = staged as Record<string, string>;

/** Pure mapping, exported for tests: local /assets path -> staged R2 URL (or unchanged). */
export function resolveAssetUrl(path: string, base: string, stagedMap: Record<string, string>): string {
  if (!base || !path.startsWith("/assets/")) return path;
  const key = stagedMap[path.slice(path.lastIndexOf("/") + 1)];
  return key ? `${base}/${key}` : path;
}

export function assetUrl(path: string): string {
  return resolveAssetUrl(path, ASSET_BASE, STAGED);
}

type ManifestLike = {
  districts: { url: string; collisionUrl?: string }[];
  links?: string;
  shell?: string;
};

/** Resolve a districts.json manifest's GLB fields through assetUrl; all other data stays as-is. */
export function resolveManifestAssets<M extends ManifestLike>(m: M): M {
  return {
    ...m,
    links: m.links ? assetUrl(m.links) : m.links,
    shell: m.shell ? assetUrl(m.shell) : m.shell,
    districts: m.districts.map((d) => ({
      ...d,
      url: assetUrl(d.url),
      collisionUrl: d.collisionUrl ? assetUrl(d.collisionUrl) : d.collisionUrl,
    })),
  };
}
