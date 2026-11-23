import { endSession, mcp, startSession } from "./verse-session";
const s = await startSession("Wren-" + crypto.randomUUID().slice(0, 4));
try {
  console.log("whoami:", JSON.stringify(await mcp(s.token, "agent_whoami", { agent_id: s.agentId })).slice(0, 400));
  console.log("attach:", JSON.stringify(await mcp(s.token, "body_attach", { agent_id: s.agentId, body: "summer" })).slice(0, 300));
  const obs = await mcp(s.token, "world_observe", { agent_id: s.agentId });
  console.log("observe:", JSON.stringify(obs).slice(0, 900));
} catch (e) { console.log("FAIL:", String(e).slice(0, 500)); }
finally { await endSession(s); }
