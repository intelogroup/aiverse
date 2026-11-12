import { describe, expect, it, vi } from "vitest";
import { probeWebGLSupport, type ProbeCanvasLike, type WebGLContextLike } from "./contextCreate";

/** Fake GL context that records the lose-context release. */
function fakeContext() {
  const loseContext = vi.fn();
  const gl: WebGLContextLike = {
    getExtension: (name: string) => (name === "WEBGL_lose_context" ? { loseContext } : null),
  };
  return { gl, loseContext };
}

/** Fake canvas whose getContext answers from a per-kind script. */
function fakeCanvas(script: Record<string, WebGLContextLike | null | "throw">) {
  const getContext = vi.fn((kind: string) => {
    const answer = script[kind] ?? null;
    if (answer === "throw") throw new Error("getContext blew up");
    return answer;
  });
  const canvas: ProbeCanvasLike = { getContext };
  return { canvas, getContext };
}

describe("probeWebGLSupport", () => {
  it("passes when webgl2 is available and releases the probe context", () => {
    const { gl, loseContext } = fakeContext();
    const { canvas, getContext } = fakeCanvas({ webgl2: gl });
    expect(probeWebGLSupport(() => canvas)).toBe(true);
    expect(getContext).toHaveBeenCalledTimes(1);
    expect(loseContext).toHaveBeenCalledTimes(1);
  });

  it("falls back to webgl when webgl2 is refused", () => {
    const { gl } = fakeContext();
    const { canvas, getContext } = fakeCanvas({ webgl2: null, webgl: gl });
    expect(probeWebGLSupport(() => canvas)).toBe(true);
    expect(getContext.mock.calls.map((c) => c[0])).toEqual(["webgl2", "webgl"]);
  });

  it("fails when the browser refuses every context — the AIVERSE-5 shape", () => {
    const { canvas } = fakeCanvas({ webgl2: null, webgl: null });
    expect(probeWebGLSupport(() => canvas)).toBe(false);
  });

  it("never throws: a throwing getContext is just 'not supported'", () => {
    const { canvas } = fakeCanvas({ webgl2: "throw", webgl: "throw" });
    expect(() => probeWebGLSupport(() => canvas)).not.toThrow();
    expect(probeWebGLSupport(() => canvas)).toBe(false);
  });

  it("never throws: a throwing canvas factory is just 'not supported'", () => {
    expect(
      probeWebGLSupport(() => {
        throw new Error("no canvas API");
      }),
    ).toBe(false);
  });

  it("still passes when the release extension is missing", () => {
    const gl: WebGLContextLike = { getExtension: () => null };
    const { canvas } = fakeCanvas({ webgl2: gl });
    expect(probeWebGLSupport(() => canvas)).toBe(true);
  });
});
