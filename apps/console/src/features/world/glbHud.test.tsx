import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WalkHudPanel } from "./glbHud";
import { WalkClipOverride } from "./walkOverride";
import { teaStandPose } from "./teaDoor";

const door = (status: string | null = null) => ({ state: "closed", phase: "idle", status: () => status, request: vi.fn() });
const at = (x: number, z: number) => ({ current: { state: "idle", speed: 0, x, z } });
const sound = { consent: "unknown", muted: false, grantConsent: vi.fn(), declineConsent: vi.fn(), setMuted: vi.fn() };
const panel = (props: Record<string, unknown>) =>
  render(<WalkHudPanel {...({ override: new WalkClipOverride(), frameRef: at(9999, 9999), ...props } as any)} />);

afterEach(() => {
  cleanup();
  window.history.replaceState(null, "", "/");
});

describe("WalkHudPanel", () => {
  it("renders nothing when idle without ?debug=1", () => {
    expect(panel({ door: door() }).container.innerHTML).toBe("");
  });

  it("keeps sound consent, door action and status without ?debug=1", () => {
    const d = door("too far from the door");
    const p = teaStandPose("OpenDoorInwards");
    panel({ door: d, sound, frameRef: at(p.x, p.z) });
    expect(screen.queryByText(/Walk clips/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Run" })).toBeNull();
    expect(screen.queryByText(/anim /)).toBeNull();
    expect(screen.getByRole("button", { name: "Enable sound" })).toBeTruthy();
    expect(screen.getByText("too far from the door")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open the Tea House door" }));
    expect(d.request).toHaveBeenCalledWith("OpenDoorInwards");
  });

  it("shows the test buttons with ?debug=1", () => {
    window.history.replaceState(null, "", "/?debug=1");
    panel({ door: door() });
    expect(screen.getByText(/Walk clips/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run" })).toBeTruthy();
  });
});
