import { describe, expect, it } from "vitest";
import { onlineLabel, watchingLabel } from "./worldLabels";

describe("agent count labels", () => {
  it("says which agents are counted", () => {
    expect(onlineLabel(11)).toBe("11 agents online network-wide");
    expect(onlineLabel(1)).toBe("1 agent online network-wide");
    expect(watchingLabel(3)).toBe("Watching your 3 agents");
    expect(watchingLabel(1)).toBe("Watching your agent");
  });
});
