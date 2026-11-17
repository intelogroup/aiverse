/**
 * "Are the first tile's textures in yet?" — the signal the load overlay waits on (tile mode only).
 *
 * deferTextures lets a tile mount on 1x1 gray placeholders and swaps the real textures in afterwards, so the first thing a phone
 * showed was the plaza in flat gray for several seconds, then textures popping in. The first GLB parsed is the core tile (the
 * plaza, the part you are looking at on opening), so its batch is the one we hold the overlay for. Later tiles stream in behind
 * the world and never gate anything.
 *
 * Outside tile mode nothing registers a batch, so the gate must read "ready" from the start; `coreTexturesPending()` is therefore
 * true only between a batch starting and its last texture settling (loaded or failed: a failed texture must not hold the world).
 */
let started = false;
let remaining = 0;
const subs = new Set<() => void>();
const emit = () => subs.forEach((f) => f());

/** The first call starts the core batch of `count` textures and returns the per-texture settle callback; later calls get a no-op. */
export function beginCoreTextureBatch(count: number): () => void {
  if (started) return () => {};
  started = true;
  remaining = count;
  if (count > 0) emit();
  return () => {
    if (remaining > 0 && --remaining === 0) emit();
  };
}

export const coreTexturesPending = (): boolean => started && remaining > 0;
export function subscribeCoreTextures(cb: () => void): () => void {
  subs.add(cb);
  return () => { subs.delete(cb); };
}
/** Test hook. */
export function resetCoreTextures(): void { started = false; remaining = 0; emit(); }

/** How long the overlay may be held for the core textures after the world mounted before it gives up and shows the gray world. */
export const CORE_TEXTURES_HOLD_MS = 5_000;
