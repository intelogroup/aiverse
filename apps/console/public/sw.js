/* AIVerse asset service worker.
 *
 * Cache-first runtime caching for the world/body GLBs served from the R2
 * `verse-assets` bucket (content-hashed, immutable URLs — see
 * src/lib/assetUrl.ts). Repeat visits serve the world from Cache Storage
 * instead of re-downloading tens of MB.
 *
 * Scope discipline: ONLY GET requests to the R2 origin under /glbs/ are
 * intercepted. Navigations/HTML, /api calls, websockets, and every other
 * origin pass straight through — the app shell is never cached here.
 *
 * Eviction: an app-managed LRU capped at MAX_BYTES. The LRU manifest lives
 * in IndexedDB and holds only {url, size, lastAccess} rows — never blobs
 * (blobs live in Cache Storage). If IndexedDB is unavailable the cache
 * still works, just without trimming (the browser quota remains the bound).
 *
 * The cache is disposable by design: browsers may evict it under storage
 * pressure, and Safari wipes script-writable storage after ~7 days without
 * a visit. A cold cache simply refetches from R2 — nothing here is the
 * only copy of anything.
 */
"use strict";

const VERSION = "v1";
const CACHE_NAME = `aiverse-glbs-${VERSION}`;
const R2_ORIGIN = "https://verse.clixen.app";
const MAX_BYTES = 500 * 1024 * 1024; // ~500 MB: the full staged set is ~215 MB; headroom for a second world version during deploys, far below desktop quotas and near what a phone can spare.
const DB_NAME = "aiverse-asset-lru";
const STORE = "entries";

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: "url" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbTx(mode, fn) {
  try {
    const db = await idbOpen();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const out = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(out && out.result !== undefined ? out.result : undefined);
      tx.onerror = () => reject(tx.error);
    });
  } catch {
    return undefined; // LRU bookkeeping must never break asset loads.
  }
}

const lruTouch = (url, size) =>
  idbTx("readwrite", (s) => s.put({ url, size: size ?? 0, lastAccess: Date.now() }));
const lruAll = () => idbTx("readonly", (s) => s.getAll());
const lruDrop = (url) => idbTx("readwrite", (s) => s.delete(url));

async function trimLru(cache, keepUrl) {
  const entries = (await lruAll()) || [];
  let total = entries.reduce((n, e) => n + (e.size || 0), 0);
  if (total <= MAX_BYTES) return;
  entries.sort((a, b) => a.lastAccess - b.lastAccess);
  for (const e of entries) {
    if (total <= MAX_BYTES) break;
    if (e.url === keepUrl) continue;
    await cache.delete(e.url);
    await lruDrop(e.url);
    total -= e.size || 0;
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const hit = await cache.match(request);
  if (hit) {
    void lruTouch(request.url, Number(hit.headers.get("content-length")) || undefined);
    return hit;
  }
  const response = await fetch(request);
  if (response.status === 200) {
    const size = Number(response.headers.get("content-length")) || 0;
    await cache.put(request, response.clone());
    await lruTouch(request.url, size);
    void trimLru(cache, request.url);
  }
  return response;
}

self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const names = await caches.keys();
      await Promise.all(
        names.filter((n) => n.startsWith("aiverse-glbs-") && n !== CACHE_NAME).map((n) => caches.delete(n)),
      );
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== R2_ORIGIN || !url.pathname.startsWith("/glbs/")) return;
  event.respondWith(cacheFirst(request));
});
