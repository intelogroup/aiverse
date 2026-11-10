import * as THREE from "three";
import { KTX2Loader } from "three/addons/loaders/KTX2Loader.js";

// world-city3.glb ships KHR_texture_basisu (KTX2) textures. three's GLTFLoader fails on
// them unless a KTX2Loader is attached, and a KTX2Loader throws unless detectSupport()
// has run against the live renderer first — so every console GLTF load routes through
// here (drei useGLTF via extendGltf, DistrictWorld's streaming loader directly), the
// same discipline the meshopt decoder follows (guarded by tests/meshopt-decoder.test.ts).
// The transcoder itself is served from /basis/ (three's basis_transcoder.js/.wasm).
// The loader param is a structural method type: drei's extendLoader speaks
// three-stdlib's GLTFLoader while DistrictWorld builds three/addons' — method
// bivariance lets both satisfy this shape without importing either loader class.
type GltfLoaderLike = { setKTX2Loader(loader: KTX2Loader): unknown };
let ktx2: KTX2Loader | null = null;
let primed = false;

export function configureGltfLoader(loader: GltfLoaderLike, renderer?: THREE.WebGLRenderer): void {
  if (!ktx2) ktx2 = new KTX2Loader().setTranscoderPath("/basis/");
  if (renderer && !primed) {
    ktx2.detectSupport(renderer);
    primed = true;
  }
  loader.setKTX2Loader(ktx2);
}

/** drei useGLTF extendLoader form: useGLTF(url, true, true, extendGltf(gl)).
 *  The callback param is typed as object on purpose: drei's ExtendLoader speaks
 *  three-stdlib's GLTFLoader, whose KTX2Loader declaration is incompatible with
 *  @types/three's — the cast back to GltfLoaderLike happens once, here. */
export function extendGltf(renderer?: THREE.WebGLRenderer) {
  return (loader: object) => configureGltfLoader(loader as GltfLoaderLike, renderer);
}
