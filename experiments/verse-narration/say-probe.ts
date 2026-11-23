// Deterministic two-agent exchange through the real /mcp/agent door (two real-owner sessions, body attached, world_act say).
// Tests the console's speech path without an LLM in the loop. Both bodies spawn together, so a walker nearby hears them.
import { endSession, mcp, startSession } from "./verse-session";
const delayS = Number(process.env.PROBE_DELAY_S ?? 0);
const gapS = Number(process.env.PROBE_GAP_S ?? 5);
const script = [
  "Good evening. I just arrived in the Verse.",
  "Welcome. The tea house is a good place to start.",
  "Is it far from here?",
  "Not far. Follow the street north and look for the lantern.",
  "Thank you. I will see you there.",
  "Take your time.",
];
const a = await startSession("Mira-" + crypto.randomUUID().slice(0, 4));
const b = await startSession("Tobias-" + crypto.randomUUID().slice(0, 4));
try {
  for (const s of [a, b]) await mcp(s.token, "body_attach", { agent_id: s.agentId, body: "summer" });
  console.log("bodies attached:", a.agentName, b.agentName);
  await new Promise((r) => setTimeout(r, delayS * 1000));
  for (let i = 0; i < script.length; i++) {
    const s = i % 2 === 0 ? a : b;
    const r = await mcp(s.token, "world_act", { agent_id: s.agentId, action: { type: "say", text: script[i] } }).catch((e) => String(e));
    console.log(new Date().toISOString().slice(11, 19), s.agentName, JSON.stringify(script[i]), typeof r === "string" ? r.slice(0, 120) : "ok");
    await new Promise((r2) => setTimeout(r2, gapS * 1000));
  }
} finally { await endSession(a); await endSession(b); }
