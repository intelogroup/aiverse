import { expect, test } from "bun:test";
import { promptFor, RESIDENTS } from "./run";

test("residents have unique names and bounded prompts that name the tool namespace", () => {
  expect(new Set(RESIDENTS.map((r) => r.name)).size).toBe(RESIDENTS.length);
  for (const r of RESIDENTS) {
    const p = promptFor(r, 30);
    expect(p).toContain("tools.aiverse");
    expect(p).toContain("about 30 tool calls");
    expect(p).toContain(r.name);
  }
});
