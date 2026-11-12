import { describe, expect, it, vi } from "vitest";
import { attachContextLossHandlers } from "./contextLoss";

/** Minimal EventTarget stand-in that records listeners and can fire. */
class FakeTarget {
  private listeners = new Map<string, Set<(ev: Event) => void>>();

  addEventListener(type: string, listener: (ev: Event) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  fire(type: string): Event {
    const ev = new Event(type, { cancelable: true });
    for (const fn of this.listeners.get(type) ?? []) fn(ev);
    return ev;
  }

  count(type: string): number {
    return this.listeners.get(type)?.size ?? 0;
  }
}

describe("attachContextLossHandlers", () => {
  it("prevents the default on loss (restoration stays possible) and notifies", () => {
    const target = new FakeTarget();
    const onLost = vi.fn();
    attachContextLossHandlers(target, { onLost, onRestored: vi.fn() });
    const ev = target.fire("webglcontextlost");
    expect(ev.defaultPrevented).toBe(true);
    expect(onLost).toHaveBeenCalledTimes(1);
  });

  it("notifies on restore so the recovery UI can stand down", () => {
    const target = new FakeTarget();
    const onRestored = vi.fn();
    attachContextLossHandlers(target, { onLost: vi.fn(), onRestored });
    target.fire("webglcontextrestored");
    expect(onRestored).toHaveBeenCalledTimes(1);
  });

  it("detach removes both listeners — a remounted canvas starts clean", () => {
    const target = new FakeTarget();
    const onLost = vi.fn();
    const detach = attachContextLossHandlers(target, { onLost, onRestored: vi.fn() });
    detach();
    expect(target.count("webglcontextlost")).toBe(0);
    expect(target.count("webglcontextrestored")).toBe(0);
    target.fire("webglcontextlost");
    expect(onLost).not.toHaveBeenCalled();
  });
});
