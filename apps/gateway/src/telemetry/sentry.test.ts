import { describe, expect, test } from "bun:test";
import { captureGatewayError, fingerprintError, gatewayRelease, initGatewaySentry } from "./sentry";

function boom(): Error {
  return new Error("boom at the fountain");
}

describe("fingerprintError", () => {
  test("is stable for the same defect, regardless of call site", () => {
    const a = fingerprintError(boom());
    const b = fingerprintError(boom());
    expect(a).toBe(b);
    expect(a.startsWith("fp_")).toBe(true);
  });

  test("normalizes variable payload out of the message", () => {
    const throwAt = (id: string): Error => new Error(`agent ${id} exploded`);
    // Same helper line, only the embedded id differs → same fingerprint.
    expect(fingerprintError(throwAt("42"))).toBe(fingerprintError(throwAt("98765")));
  });

  test("differs across messages and names", () => {
    expect(fingerprintError(new Error("one"))).not.toBe(fingerprintError(new Error("two")));
    expect(fingerprintError(new TypeError("one"))).not.toBe(fingerprintError(new RangeError("one")));
  });

  test("accepts non-Error values", () => {
    expect(fingerprintError("a string failure").startsWith("fp_")).toBe(true);
  });
});

describe("env-gated capture", () => {
  test("init is a no-op without SENTRY_DSN and capture reports false", () => {
    const prev = process.env.SENTRY_DSN;
    delete process.env.SENTRY_DSN;
    try {
      // NOTE: init is idempotent per process; in the suite environment no
      // DSN is configured, so the module must stay disabled end to end.
      expect(initGatewaySentry()).toBe(false);
      expect(captureGatewayError(new Error("never leaves the process"))).toBe(false);
    } finally {
      if (prev !== undefined) process.env.SENTRY_DSN = prev;
    }
  });

  test("release falls back to 'unknown' off-Render", () => {
    const prevSha = process.env.RENDER_GIT_COMMIT;
    const prevGit = process.env.GIT_SHA;
    delete process.env.RENDER_GIT_COMMIT;
    delete process.env.GIT_SHA;
    try {
      expect(gatewayRelease()).toBe("unknown");
    } finally {
      if (prevSha !== undefined) process.env.RENDER_GIT_COMMIT = prevSha;
      if (prevGit !== undefined) process.env.GIT_SHA = prevGit;
    }
  });
});
