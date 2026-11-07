import { afterEach, describe, expect, it, vi } from "vitest";
import { SoundDirector } from "./soundDirector";

// The consent gate (the director never touches audio before the user's
// explicit yes) and the voice emitter's no-context behaviour. jsdom has
// no AudioContext, so a counting stub stands in for the constructor.
function stubAudioContext(onConstruct: () => void) {
  const ctor = vi.fn(function () {
    onConstruct();
    throw new Error("ctor reached");
  });
  vi.stubGlobal("AudioContext", ctor);
  (window as unknown as { AudioContext: unknown }).AudioContext = ctor;
  return ctor;
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete (window as unknown as { AudioContext?: unknown }).AudioContext;
});

describe("SoundDirector consent gate", () => {
  it("starts unconsented, and arm() before consent never builds an AudioContext", () => {
    const ctor = stubAudioContext(() => {});
    const d = new SoundDirector();
    expect(d.consent).toBe("unknown");
    d.arm();
    d.arm();
    expect(ctor).not.toHaveBeenCalled();
    expect(d.consent).toBe("unknown");
  });

  it("a decline is final for the session: a later grant is ignored", () => {
    const ctor = stubAudioContext(() => {});
    const d = new SoundDirector();
    d.declineConsent();
    expect(d.consent).toBe("declined");
    d.grantConsent();
    d.arm();
    expect(d.consent).toBe("declined");
    expect(ctor).not.toHaveBeenCalled();
  });

  it("grant sets consent and arms, i.e. reaches the AudioContext constructor", () => {
    const ctor = stubAudioContext(() => {});
    const d = new SoundDirector();
    expect(() => d.grantConsent()).toThrow("ctor reached");
    expect(d.consent).toBe("granted");
    expect(ctor).toHaveBeenCalledTimes(1);
  });

  it("declining after a grant does not revoke it", () => {
    stubAudioContext(() => {});
    const d = new SoundDirector();
    expect(() => d.grantConsent()).toThrow();
    d.declineConsent();
    expect(d.consent).toBe("granted");
  });
});

describe("SoundDirector voice emitter without a context", () => {
  it("plays nothing and reports silence", () => {
    const d = new SoundDirector();
    expect(d.voicePlaying).toBe(false);
    const seconds = d.playVoicePcm(new Float32Array(2400), 24000, { x: 0, z: 0 }, "mage");
    expect(seconds).toBe(0);
    expect(d.voicePlaying).toBe(false);
  });
});
