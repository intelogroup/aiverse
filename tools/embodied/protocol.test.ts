import { test, expect } from "bun:test";
import { ActionLedger, validAction } from "./protocol";
test("physical tool boundary rejects debug commands and malformed coordinates", () => {
  for (const a of [{type:"teleport",point:[0,0]}, {type:"go_to",point:[NaN,0]}, {type:"go_to",point:[0,0],place:"tea"}, {type:"stop",eval:"x"}, {type:"wait",seconds:Infinity}]) expect(validAction(a)).toBe(false);
  expect(validAction({type:"go_to",point:[4,5]})).toBe(true);
});
test("retries reuse result without moving twice, conflicting replay rejected", async () => {
  const ledger = new ActionLedger(); let calls = 0;
  const act = {type:"go_to",point:[4,5]};
  await Promise.all([ledger.run("one",act,async()=>++calls),ledger.run("one",act,async()=>++calls)]);
  expect(calls).toBe(1);
  expect(()=>ledger.run("one",{type:"stop"},async()=>0)).toThrow();
});

test("agents can choose social gestures and posture through the host", () => {
  expect(validAction({ type: "play", clip: "Waving" })).toBe(true);
  expect(validAction({ type: "play", clip: "OpenDoor" })).toBe(false);
  expect(validAction({ type: "play", clip: "Waving", seconds: 60 })).toBe(false);
  expect(validAction({ type: "sit", sittable: "tea-chair" })).toBe(true);
  expect(validAction({ type: "stand" })).toBe(true);
  expect(validAction({ type: "stand", point: [0, 0] })).toBe(false);
});
