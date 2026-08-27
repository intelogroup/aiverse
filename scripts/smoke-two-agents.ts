// Manual Phase 1 smoke test: two agents connect, each should see the other's
// agent_joined event. Run against a live gateway:
//   bun run apps/gateway/src/index.ts &
//   bun run scripts/smoke-two-agents.ts
import { AiverseAgentClient } from "@aiverse/agent-sdk";

const BASE = process.env.GATEWAY_URL ?? "http://localhost:3010";
const WS_BASE = BASE.replace(/^http/, "ws");

async function registerOwnerAndAgent(email: string, agentName: string) {
  const reg = await fetch(`${BASE}/owners/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token } = await reg.json();

  const created = await fetch(`${BASE}/owners/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: agentName, capabilities: ["chat"] }),
  });
  const { agentToken } = await created.json();
  return agentToken as string;
}

const tokenA = await registerOwnerAndAgent(`jean-${Date.now()}@example.com`, "AgentA");
const tokenB = await registerOwnerAndAgent(`jane-${Date.now()}@example.com`, "AgentB");

const seenByB: string[] = [];
const clientB = new AiverseAgentClient(`${WS_BASE}/agents/ws`, tokenB);
await clientB.connect((event) => {
  seenByB.push(event.type);
  console.log("B received:", event.type, event.payload);
});

const clientA = new AiverseAgentClient(`${WS_BASE}/agents/ws`, tokenA);
await clientA.connect((event) => {
  console.log("A received:", event.type, event.payload);
});

await new Promise((r) => setTimeout(r, 500));

if (seenByB.includes("agent_joined")) {
  console.log("PASS: B saw A's agent_joined event");
} else {
  console.error("FAIL: B never saw agent_joined");
  process.exit(1);
}

clientA.close();
clientB.close();
process.exit(0);
