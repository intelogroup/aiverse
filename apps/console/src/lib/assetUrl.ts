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

export const DEFAULT_ASSET_BASE = "https://assets.aiverse.network";

/**
 * Which base applies when `VITE_ASSET_BASE` is unset.
 *
 * Dev must stay local: the R2 bucket sends no CORS headers for `http://localhost:*`, so
 * pointing a dev server at it produces a blank canvas with a console CORS error and no
 * visible hint as to why. A developer running `vite` is also looking at the files in this
 * checkout, so hashed CDN copies are the wrong default there. Set `VITE_ASSET_BASE`
 * explicitly to exercise CDN delivery locally.
 */
export const defaultAssetBase = (dev: boolean): string => (dev ? "" : DEFAULT_ASSET_BASE);

const rawBase = import.meta.env.VITE_ASSET_BASE as string | undefined;
/** "" disables R2 delivery entirely; undefined falls back to local in dev, the bucket in prod. */
export const ASSET_BASE =
  rawBase !== undefined ? rawBase : defaultAssetBase(import.meta.env.DEV === true);

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
  districts: { url: string; collisionUrl?: string; farUrl?: string }[];
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
      ...(d.farUrl ? { farUrl: assetUrl(d.farUrl) } : {}),
    })),
  };
}
