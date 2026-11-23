// A second real-owner agent for the recording: it walks to the Tea House first, goes in, and answers when someone speaks.
// Scripted replies (no LLM) so the exchange is repeatable; everything else is the real path (OAuth, visit, body, /mcp/agent).
import { writeFile } from "node:fs/promises";
import { endSession, mcp, startSession } from "./verse-session";

const READY_FILE = process.env.GREETER_READY_FILE;
const BODY = process.env.GREETER_BODY ?? "business";
const REPLIES = [
  "Welcome to the Matchmaker's Tea House. I'm Tobias. Is this your first visit?",
  "Then you must try the jasmine. Please, make yourself comfortable.",
  "Take your time. I'll be right here.",
];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const s = await startSession("Tobias-" + crypto.randomUUID().slice(0, 4));
const act = (action: object) => mcp(s.token, "world_act", { agent_id: s.agentId, action });
const observe = async () => (await mcp(s.token, "world_observe", { agent_id: s.agentId })).observation;
try {
  await mcp(s.token, "body_attach", { agent_id: s.agentId, body: BODY }).catch(async () => mcp(s.token, "body_attach", { agent_id: s.agentId, body: "summer" }));
  console.log("greeter attached:", s.agentName);
  await act({ type: "go_to", place: "shop-102" });
  const t0 = Date.now();
  for (;;) {
    const o = await observe();
    if (o.nearestPlace?.id === "shop-102" && o.nearestPlace.dist < 8) break;
    if (Date.now() - t0 > 240_000) throw new Error("never reached the tea house");
    await sleep(3000);
  }
  await act({ type: "enter", place: "shop-102" });
  await sleep(6000);
  console.log("greeter at the tea house");
  if (READY_FILE) await writeFile(READY_FILE, JSON.stringify({ agentId: s.agentId, name: s.agentName }));
  let seen = 0, said = 0;
  const end = Date.now() + 300_000;
  while (Date.now() < end && said < REPLIES.length) {
    const o = await observe();
    const fresh = (o.heard ?? []).filter((h: { seq: number; name: string }) => h.seq > seen && h.name !== s.agentName);
    for (const h of o.heard ?? []) seen = Math.max(seen, h.seq);
    if (fresh.length) {
      await sleep(2500); // a beat before answering
      await act({ type: "say", text: REPLIES[said++] });
      console.log("greeter said:", REPLIES[said - 1]);
      await sleep(5000);
    }
    await sleep(2000);
  }
} finally {
  await endSession(s);
}
