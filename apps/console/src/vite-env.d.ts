/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL?: string;
  readonly VITE_WS_URL?: string;
  /** Asset base override for GLB delivery; "" disables R2 and keeps local /assets. */
  readonly VITE_ASSET_BASE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Build-time: this build ships the world tiles (vite.config.ts). */
declare const __TILES_DEFAULT__: boolean;
