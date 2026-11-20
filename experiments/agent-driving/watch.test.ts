import { expect, test } from "bun:test";
import { watchChange } from "./watch";

const key = (over: Partial<Parameters<typeof watchChange>[0]> = {}) => ({ light: "green" as "red" | "yellow" | "green" | null, canStop: true as boolean | null, moving: true, walkers: 0, ...over });

test("watch wakes on a light change, a lost stop, a finished move and a new pedestrian", () => {
  expect(watchChange(key(), key({ light: "yellow" }))).toBe("light_yellow");
  expect(watchChange(key(), key({ canStop: false }))).toBe("cannot_stop_before_line");
  expect(watchChange(key(), key({ moving: false }))).toBe("movement_finished");
  expect(watchChange(key(), key({ walkers: 1 }))).toBe("pedestrian_appeared");
});

test("watch stays asleep when nothing changed", () => {
  expect(watchChange(key(), key())).toBeNull();
  expect(watchChange(key({ canStop: false }), key({ canStop: true }))).toBeNull();
});
