import { describe, expect, it, vi } from "vitest";
import { IDLE_STAGE, hudBridge } from "./hudBridge";

describe("hudBridge", () => {
  it("notifies only when the stage changes, and resets on unregister", () => {
    const seen = vi.fn();
    const off = hudBridge.subscribe(seen);
    const unregister = hudBridge.register({ follow: vi.fn(), toggleFollow: vi.fn(), walk: vi.fn(), bodies: () => [], focus: () => null, root: { current: null } });
    seen.mockClear();
    hudBridge.publish({ ...IDLE_STAGE, present: ["Ada"] });
    hudBridge.publish({ ...IDLE_STAGE, present: ["Ada"] });
    expect(seen).toHaveBeenCalledTimes(1);
    unregister();
    expect(hudBridge.getSnapshot()).toEqual({ stage: IDLE_STAGE, actions: null });
    off();
  });
});
