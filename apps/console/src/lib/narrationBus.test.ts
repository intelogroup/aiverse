import { describe, expect, it } from "vitest";
import { publishNarration, subscribeNarration, type AgentNarration } from "./narrationBus";

const n: AgentNarration = { agentId: "a", agentName: "Wren", kind: "visible", text: "hi", at: 1 };

describe("narrationBus", () => {
  it("delivers to subscribers until they unsubscribe", () => {
    const got: string[] = [];
    const off = subscribeNarration((x) => got.push(x.text));
    publishNarration(n);
    off();
    publishNarration({ ...n, text: "later" });
    expect(got).toEqual(["hi"]);
  });
  it("a throwing listener does not stop the others", () => {
    const got: string[] = [];
    const a = subscribeNarration(() => { throw new Error("boom"); });
    const b = subscribeNarration((x) => got.push(x.text));
    publishNarration(n);
    a(); b();
    expect(got).toEqual(["hi"]);
  });
});
