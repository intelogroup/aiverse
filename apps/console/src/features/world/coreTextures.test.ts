import { beforeEach, describe, expect, it, vi } from "vitest";
import { beginCoreTextureBatch, coreTexturesPending, resetCoreTextures, subscribeCoreTextures } from "./coreTextures";

describe("coreTextures", () => {
  beforeEach(() => resetCoreTextures());

  it("is not pending before any batch (non-tile builds never register one)", () => {
    expect(coreTexturesPending()).toBe(false);
  });

  it("is pending until the last texture of the FIRST batch settles, and notifies", () => {
    const cb = vi.fn();
    const off = subscribeCoreTextures(cb);
    const settle = beginCoreTextureBatch(2);
    expect(coreTexturesPending()).toBe(true);
    settle();
    expect(coreTexturesPending()).toBe(true);
    settle();
    expect(coreTexturesPending()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(2); // batch started, batch finished
    off();
  });

  it("later batches (streamed tiles) never hold anything", () => {
    beginCoreTextureBatch(1)();
    const later = beginCoreTextureBatch(5);
    expect(coreTexturesPending()).toBe(false);
    later(); later();
    expect(coreTexturesPending()).toBe(false);
  });

  it("an empty core batch is not pending", () => {
    beginCoreTextureBatch(0);
    expect(coreTexturesPending()).toBe(false);
  });

  it("extra settle calls cannot drive the counter negative or re-notify", () => {
    const cb = vi.fn();
    subscribeCoreTextures(cb);
    const settle = beginCoreTextureBatch(1);
    settle(); settle(); settle();
    expect(coreTexturesPending()).toBe(false);
    expect(cb).toHaveBeenCalledTimes(2);
  });
});
