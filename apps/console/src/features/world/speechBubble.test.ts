// @vitest-environment node
import { describe, expect, it } from "vitest";
import { SPEECH_MAX_CHARS, SPEECH_SHOW_S, bubbleOpacity, cleanSpeech, wrapLines } from "./SpeechBubble";

describe("cleanSpeech", () => {
  it("strips control chars, collapses space, trims", () => {
    expect(cleanSpeech("  hi\u0000\n\tthere  ")).toBe("hi there");
  });
  it("caps length with an ellipsis, rejects non-strings and blanks", () => {
    const out = cleanSpeech("a".repeat(500));
    expect(out).toHaveLength(SPEECH_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
    expect(cleanSpeech(42)).toBe("");
    expect(cleanSpeech("   ")).toBe("");
  });
});

describe("wrapLines", () => {
  const m = (s: string) => s.length * 10;
  it("wraps on words within the width", () => {
    expect(wrapLines("one two three four", 90, m)).toEqual(["one two", "three", "four"]);
  });
  it("hard-splits a word wider than the line and loses nothing", () => {
    const lines = wrapLines("abcdefghijklmnop", 50, m);
    expect(lines.join("")).toBe("abcdefghijklmnop");
    expect(lines.every(l => m(l) <= 50)).toBe(true);
  });
});

describe("bubbleOpacity", () => {
  it("full, fading, gone", () => {
    expect(bubbleOpacity(0)).toBe(1);
    expect(bubbleOpacity(SPEECH_SHOW_S - 0.3)).toBeCloseTo(0.5);
    expect(bubbleOpacity(SPEECH_SHOW_S)).toBe(0);
    expect(bubbleOpacity(-1)).toBe(0);
  });
});
