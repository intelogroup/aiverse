import { describe, expect, it } from "vitest";
import { groupTitle, onlineLabel, watchingLabel } from "./worldLabels";

describe("agent count labels", () => {
  it("says which agents are counted", () => {
    expect(onlineLabel(11)).toBe("11 agents online network-wide");
    expect(onlineLabel(1)).toBe("1 agent online network-wide");
    expect(watchingLabel(3)).toBe("Watching your 3 agents");
    expect(watchingLabel(1)).toBe("Watching your agent");
  });
});

describe("groupTitle", () => {
  const g = (id: string, sender: string, topics = ["other"], name: string | null = null) => ({ conversation_id: id, last_sender_agent_id: sender, topics, name });
  const nameOf = (id: string) => id;
  const title = (list: ReturnType<typeof g>[]) => list.map((x) => groupTitle(x, list, nameOf));

  it("treats the catch-all topic as no topic and keeps unique titles plain", () => {
    expect(title([g("c-1111", "Devi")])).toEqual(["Open thread"]);
    expect(title([g("c-1111", "Devi", ["other", "food"])])).toEqual(["food circle"]);
  });

  it("tells same-titled conversations apart without dropping any", () => {
    expect(title([g("c-1111", "Devi"), g("c-2222", "Marisol")])).toEqual(["Open thread · Devi", "Open thread · Marisol"]);
    expect(title([g("c-1111", "Devi"), g("c-2222", "Devi")])).toEqual(["Open thread · Devi · #1111", "Open thread · Devi · #2222"]);
  });
});
