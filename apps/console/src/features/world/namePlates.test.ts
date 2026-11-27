import { describe, expect, it } from "vitest";
import { plateFor, plateLevels } from "./namePlates";

describe("plateFor", () => {
  it("gives level to your own agents only", () => {
    plateLevels.set("Ada", 3);
    plateLevels.set("Zed", 9);
    expect(plateFor("Ada", new Set(["Ada"]))).toEqual({ text: "Ada · Lv 3", mine: true });
    expect(plateFor("Zed", new Set(["Ada"]))).toEqual({ text: "Zed", mine: false });
    expect(plateFor("Bo", new Set(["Bo"]))).toEqual({ text: "Bo", mine: true });
  });
});
