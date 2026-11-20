export async function verifyVerseAgent(requireOwnerOAuth = false) {
  const { DRIVE_AGENT_GATEWAY_PORT: port, DRIVE_AGENT_TOKEN: token, DRIVE_AGENT_ID: agentId } = process.env;
  if (requireOwnerOAuth && (!port || !token || !agentId)) {
    throw new Error("The road benchmark requires a Verse agent ID and an owner-authorized OAuth grant.");
  }
  if (!port && !token) return undefined;
  if (!port || !/^\d{1,5}$/.test(port) || !token) throw new Error("Driving agent authentication requires a local Verse gateway and an agent token.");
  const response = await fetch(`http://127.0.0.1:${port}/mcp/agent`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    redirect: "error",
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "agent_whoami", arguments: agentId ? { agent_id: agentId } : {} } }),
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Verse agent authentication failed (${response.status}).`);
  const envelope = await response.json() as { result?: { isError?: boolean; content?: { text?: string }[] } };
  const text = envelope.result?.content?.[0]?.text;
  const who = text && JSON.parse(text) as { agent?: { id?: string; name?: string }; auth?: { kind?: string; scopes?: string[] } };
  if (!who || envelope.result?.isError || !who.agent?.id || !who.agent.name
    || (agentId && who.agent.id !== agentId)
    || (who.auth?.kind !== "agent" && who.auth?.kind !== "oauth")) {
    throw new Error("Verse gateway did not confirm the driving agent's identity.");
  }
  if (requireOwnerOAuth && (who.auth.kind !== "oauth" || !who.auth.scopes?.includes("world:observe"))) {
    throw new Error("The road benchmark requires an owner OAuth grant with world:observe and world:act.");
  }
  if (who.auth.kind === "oauth" && !who.auth.scopes?.includes("world:act")) {
    throw new Error("The owner's OAuth grant must include world:act to drive.");
  }
  return { id: who.agent.id, name: who.agent.name, authKind: who.auth.kind };
}
