import * as THREE from "three";
import type { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

/**
 * Tile mode: a GLB's textures must not hold its geometry back. GLTFLoader resolves only once every texture has downloaded and
 * transcoded, and on a phone the core tile's 1.5 MB of textures (not its 82 KB of geometry) were the whole cold-start wait.
 *
 * This plugin answers each external-uri texture at once with a 1x1 neutral placeholder (a flat normal for normal maps, mid-grey for
 * base colour, white elsewhere), so the scene mounts and the body can walk; the real texture is fetched after parse and swapped into
 * every material slot that holds the placeholder. Embedded images (buffer views) are left to the stock loader.
 *
 * Registered at the FRONT of the loader's plugin list: GLTFLoader asks plugins in order and KHR_texture_basisu would otherwise claim
 * the KTX2 textures first.
 */
type Parser = { json: GltfJson; options: { path: string; manager: THREE.LoadingManager } };
type GltfJson = {
  textures?: { source?: number; sampler?: number; extensions?: Record<string, { source?: number }> }[];
  images?: { uri?: string; mimeType?: string }[];
  samplers?: { magFilter?: number; minFilter?: number; wrapS?: number; wrapT?: number }[];
  materials?: Record<string, unknown>[];
};
type LoaderWithPlugins = { pluginCallbacks?: ((parser: Parser) => object)[]; __deferTextures?: boolean };

const FILTER: Record<number, THREE.MagnificationTextureFilter | THREE.MinificationTextureFilter> = {
  9728: THREE.NearestFilter, 9729: THREE.LinearFilter, 9984: THREE.NearestMipmapNearestFilter, 9985: THREE.LinearMipmapNearestFilter, 9986: THREE.NearestMipmapLinearFilter, 9987: THREE.LinearMipmapLinearFilter,
};
const WRAP: Record<number, THREE.Wrapping> = { 33071: THREE.ClampToEdgeWrapping, 33648: THREE.MirroredRepeatWrapping, 10497: THREE.RepeatWrapping };

/** What each texture index is used for, so the placeholder is neutral for that use (a white normal map would light everything wrongly). */
function placeholderKinds(json: GltfJson): Map<number, "normal" | "color" | "neutral"> {
  const kinds = new Map<number, "normal" | "color" | "neutral">();
  const note = (info: unknown, kind: "normal" | "color") => { const i = (info as { index?: number } | undefined)?.index; if (i !== undefined && !kinds.has(i)) kinds.set(i, kind); };
  for (const m of json.materials ?? []) {
    note((m as { normalTexture?: unknown }).normalTexture, "normal");
    note((m as { pbrMetallicRoughness?: { baseColorTexture?: unknown } }).pbrMetallicRoughness?.baseColorTexture, "color");
  }
  return kinds;
}
const PIXELS = { normal: [128, 128, 255, 255], color: [190, 182, 170, 255], neutral: [255, 255, 255, 255] } as const;
const placeholder = (kind: "normal" | "color" | "neutral") => {
  const t = new THREE.DataTexture(new Uint8Array(PIXELS[kind]), 1, 1, THREE.RGBAFormat);
  t.needsUpdate = true;
  return t;
};

type Slot = { mat: THREE.Material; key: string; tex: THREE.Texture };
/** Every texture-valued property of a material (map, normalMap, roughnessMap, ...). */
const slotsOf = (mat: THREE.Material): Slot[] => {
  const out: Slot[] = [];
  for (const [key, v] of Object.entries(mat as unknown as Record<string, unknown>)) if (v && (v as THREE.Texture).isTexture) out.push({ mat, key, tex: v as THREE.Texture });
  return out;
};

export function deferTextures(loader: object, ktx2: KTX2Loader): void {
  const l = loader as LoaderWithPlugins;
  if (l.__deferTextures || !l.pluginCallbacks) return; // configureGltfLoader runs on the same loader for every URL
  l.__deferTextures = true;
  const images = new Map<string, Promise<THREE.Texture>>(); // url -> real texture, shared by every tile that uses it in this page
  const real = (url: string, isKtx2: boolean): Promise<THREE.Texture> => {
    let p = images.get(url);
    if (!p) { p = (isKtx2 ? ktx2.loadAsync(url) : new THREE.TextureLoader().loadAsync(url)); images.set(url, p); }
    return p;
  };
  l.pluginCallbacks.unshift((parser) => {
    const json = parser.json; const kinds = placeholderKinds(json);
    return {
      name: "AIVERSE_defer_textures",
      loadTexture(index: number) {
        const def = json.textures?.[index]; if (!def) return null;
        const source = def.extensions?.KHR_texture_basisu?.source ?? def.source;
        const img = source === undefined ? undefined : json.images?.[source];
        if (!img?.uri) return null;
        const t = placeholder(kinds.get(index) ?? "neutral");
        const s = def.sampler !== undefined ? json.samplers?.[def.sampler] : undefined;
        t.flipY = false; // as GLTFLoader sets it
        t.magFilter = FILTER[s?.magFilter ?? 9729] as THREE.MagnificationTextureFilter; t.minFilter = FILTER[s?.minFilter ?? 9987] as THREE.MinificationTextureFilter;
        t.wrapS = WRAP[s?.wrapS ?? 10497]; t.wrapT = WRAP[s?.wrapT ?? 10497];
        t.userData.deferUrl = parser.options.manager.resolveURL(new URL(img.uri, new URL(parser.options.path || "./", location.href)).href);
        t.userData.deferKtx2 = img.mimeType === "image/ktx2" || img.uri.endsWith(".ktx2");
        return Promise.resolve(t);
      },
      afterRoot(result: { scene: THREE.Object3D; scenes: THREE.Object3D[] }) {
        const waiting = new Map<string, Slot[]>(); // url -> slots still on a placeholder
        const seen = new Set<THREE.Material>();
        for (const scene of result.scenes) scene.traverse((o) => {
          const m = o as THREE.Mesh; if (!m.isMesh) return;
          for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
            if (seen.has(mat)) continue; seen.add(mat);
            for (const slot of slotsOf(mat)) { const u = slot.tex.userData.deferUrl as string | undefined; if (u) (waiting.get(u) ?? waiting.set(u, []).get(u)!).push(slot); }
          }
        });
        for (const [url, slots] of waiting) {
          real(url, !!slots[0].tex.userData.deferKtx2).then((base) => {
            // Slots that shared one placeholder (one texture index) share one real texture; only a different placeholder (another
            // sampler / colour space / transform of the same image) gets its own copy.
            const groups = new Map<THREE.Texture, Slot[]>();
            for (const slot of slots) (groups.get(slot.tex) ?? groups.set(slot.tex, []).get(slot.tex)!).push(slot);
            let first = true;
            for (const [ph, ss] of groups) {
              const t = first ? base : base.clone(); first = false;
              t.flipY = false; t.colorSpace = ph.colorSpace; t.channel = ph.channel;
              t.wrapS = ph.wrapS; t.wrapT = ph.wrapT; t.magFilter = ph.magFilter; t.minFilter = ph.minFilter;
              t.offset.copy(ph.offset); t.repeat.copy(ph.repeat); t.rotation = ph.rotation; t.center.copy(ph.center); t.matrixAutoUpdate = ph.matrixAutoUpdate; if (!ph.matrixAutoUpdate) t.matrix.copy(ph.matrix);
              t.needsUpdate = true;
              for (const { mat, key } of ss) { (mat as unknown as Record<string, unknown>)[key] = t; mat.needsUpdate = true; }
              ph.dispose();
            }
          }).catch((e) => console.warn("[tiles] texture failed", url, e));
        }
      },
    };
  });
}
