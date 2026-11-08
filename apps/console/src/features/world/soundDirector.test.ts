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

describe("SoundDirector spectator drive (F1: announcements outside walk mode)", () => {
  // Verse clock starts at 150 s; dusk falls at 300 s — 150 s of
  // spectator drive. tickSpectator clamps each step to 0.5 s.
  const drive = (d: SoundDirector, seconds: number, district: string | null) => {
    for (let t = 0; t < seconds; t += 0.5) d.tickSpectator(0.5, district);
  };

  it("fires the verse-clock announcements for a spectator", () => {
    const d = new SoundDirector();
    drive(d, 150, "bazaar");
    expect(d.snapshot().announcements).toBe(1);
    expect(d.spectatorBannerText()).toBe("Dusk falls on the Sunstone Bazaar. The lamps are lit.");
  });

  it("scopes the spectator banner to the viewing district", () => {
    const water = new SoundDirector();
    drive(water, 150, null);
    expect(water.snapshot().announcements).toBe(1); // fired…
    expect(water.spectatorBannerText()).toBeNull(); // …but not for open water

    const elsewhere = new SoundDirector();
    drive(elsewhere, 150, "glass");
    expect(elsewhere.spectatorBannerText()).toBeNull();
  });

  it("leaves the walk banner (listener-scoped) alone for a pure spectator", () => {
    const d = new SoundDirector();
    drive(d, 150, "bazaar");
    expect(d.bannerText()).toBeNull(); // no listener has ever stood anywhere
  });

  it("expires the spectator banner after the audio + linger window", () => {
    const d = new SoundDirector();
    drive(d, 150, "bazaar");
    expect(d.spectatorBannerText()).not.toBeNull();
    drive(d, 10, "bazaar"); // 2.5 s clip + 1.6 s linger < 10 s; dawn is 300 s away
    expect(d.spectatorBannerText()).toBeNull();
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
