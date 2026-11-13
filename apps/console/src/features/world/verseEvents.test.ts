import { describe, expect, it, vi } from "vitest";
import { cleanDetail, cosmeticForEgg, momentCaption, momentScore, topMoments, type AgentEvent } from "@aiverse/shared/events";
import { emitMoment, onMoment } from "./verseEvents";

const ev = (type: AgentEvent["type"], detail: string, at: string, id = at + type): AgentEvent => ({ id, type, detail, at });

describe("event model", () => {
  it("cleans free text", () => expect(cleanDetail("  a\n\tb\u0000 ")).toBe("a b"));
  it("caps long text", () => expect(cleanDetail("x".repeat(500)).length).toBe(140));
  it("picks the same cosmetic for the same egg", () => expect(cosmeticForEgg("egg-bazaar-01")).toBe(cosmeticForEgg("egg-bazaar-01")));
  it("ranks claims above chatter and caps one type", () => {
    const top = topMoments([
      ev("said", "hello there friend", "1"), ev("said", "second long message", "2"), ev("said", "third long message", "3"),
      ev("claimed", "secret", "0"), ev("sat", "", "4"),
    ], 5);
    expect(top[0]!.type).toBe("claimed");
    expect(top.filter(e => e.type === "said")).toHaveLength(2);
    expect(top.some(e => e.type === "sat")).toBe(false); // below the clip threshold
  });
  it("captions read without sound", () => expect(momentCaption("said", "hi", "Scout")).toBe('Scout: "hi"'));
  it("short chatter scores below the threshold", () => expect(momentScore("said", "hi")).toBeLessThan(25));
});

describe("moment bus", () => {
  it("only offers clip-worthy moments", () => {
    const fn = vi.fn();
    const off = onMoment(fn);
    emitMoment("sat", "", "Scout");
    emitMoment("said", "hi", "Scout");
    emitMoment("claimed", "a secret", "Scout");
    off();
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn.mock.calls[0]![0]).toMatchObject({ type: "claimed", name: "Scout" });
  });
});
