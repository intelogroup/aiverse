import { describe, expect, test, afterAll } from "bun:test";
import { generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

const app = createApp();
const server = Bun.serve({ port: 0, fetch: app.fetch, websocket });

afterAll(() => {
  server.stop(true);
});

function genKeypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" }) as { x: string };
  return { publicKeyBase64Url: jwk.x, privateKey };
}

function signNonce(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], nonce: string) {
  return cryptoSign(null, Buffer.from(nonce), privateKey).toString("base64");
}

// Registers + claims an agent with an Ed25519 identity key, the only path
// that makes /auth/challenge and /auth/verify usable (both 404 without a
// registered publicKey).
async function registerAndClaimKeyedAgent(name: string) {
  const { publicKeyBase64Url, privateKey } = genKeypair();

  const reg = await app.request("/agents/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, publicKey: publicKeyBase64Url }),
  });
  const { agentId, claimCode } = await reg.json();

  const email = `auth-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const ownerReg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token: ownerToken } = await ownerReg.json();

  const claimed = await app.request("/owners/agents/claim", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ claimCode }),
  });
  expect(claimed.status).toBe(200);

  return { agentId: agentId as string, privateKey, ownerToken: ownerToken as string };
}

describe("Ed25519 challenge/verify auth", () => {
  test("full round trip: challenge -> sign -> verify -> session token works on ws-ticket", async () => {
    await resetMemoryStoreForTests();
    const { agentId, privateKey } = await registerAndClaimKeyedAgent("AuthAgent1");

    const challenge = await app.request("/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    expect(challenge.status).toBe(200);
    const { nonce } = await challenge.json();

    const verify = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, signature: signNonce(privateKey, nonce) }),
    });
    expect(verify.status).toBe(200);
    const { token } = await verify.json();
    expect(typeof token).toBe("string");

    const ticket = await app.request("/auth/ws-ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ticket.status).toBe(201);
  });

  test("wrong signature is rejected", async () => {
    await resetMemoryStoreForTests();
    const { agentId } = await registerAndClaimKeyedAgent("AuthAgent2");
    const { privateKey: wrongKey } = genKeypair();

    const challenge = await app.request("/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    const { nonce } = await challenge.json();

    const verify = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, signature: signNonce(wrongKey, nonce) }),
    });
    expect(verify.status).toBe(401);
  });

  test("a signature over the wrong nonce (replay of an old challenge) is rejected", async () => {
    await resetMemoryStoreForTests();
    const { agentId, privateKey } = await registerAndClaimKeyedAgent("AuthAgent3");

    const staleSignature = signNonce(privateKey, "0".repeat(43));

    const verify = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, signature: staleSignature }),
    });
    // no /auth/challenge was ever called, so there's no active nonce at all
    expect(verify.status).toBe(400);
  });

  test("a nonce is one-time use: verifying twice with the same signature fails the second time", async () => {
    await resetMemoryStoreForTests();
    const { agentId, privateKey } = await registerAndClaimKeyedAgent("AuthAgent4");

    const challenge = await app.request("/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    const { nonce } = await challenge.json();
    const signature = signNonce(privateKey, nonce);

    const first = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, signature }),
    });
    expect(first.status).toBe(200);

    const second = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, signature }),
    });
    expect(second.status).toBe(400);
  });

  test("challenge for an agent with no registered public key 404s", async () => {
    await resetMemoryStoreForTests();
    const email = `auth-nokey-${Date.now()}@example.com`;
    const ownerReg = await app.request("/owners/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    const { token: ownerToken } = await ownerReg.json();
    const created = await app.request("/owners/agents", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
      body: JSON.stringify({ name: "NoKeyAgent", capabilities: [] }),
    });
    const { agent } = await created.json();

    const challenge = await app.request("/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: agent.id }),
    });
    expect(challenge.status).toBe(404);
  });

  test("challenge for an unknown agentId 404s", async () => {
    await resetMemoryStoreForTests();
    const challenge = await app.request("/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(challenge.status).toBe(404);
  });

  test("challenge without agentId 400s", async () => {
    const challenge = await app.request("/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(challenge.status).toBe(400);
  });

  test("ws-ticket requires a valid session token", async () => {
    const res = await app.request("/auth/ws-ticket", { method: "POST" });
    expect(res.status).toBe(401);

    const bad = await app.request("/auth/ws-ticket", {
      method: "POST",
      headers: { authorization: "Bearer garbage" },
    });
    expect(bad.status).toBe(401);
  });

  test("a paused agent's own valid session token is rejected at ws-ticket (403)", async () => {
    await resetMemoryStoreForTests();
    const { agentId, privateKey, ownerToken } = await registerAndClaimKeyedAgent("AuthAgent5");

    const paused = await app.request(`/owners/agents/${agentId}/pause`, {
      method: "POST",
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    expect(paused.status).toBe(200);

    const challenge = await app.request("/auth/challenge", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId }),
    });
    const { nonce } = await challenge.json();
    const verify = await app.request("/auth/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId, signature: signNonce(privateKey, nonce) }),
    });
    expect(verify.status).toBe(200);
    const { token } = await verify.json();

    const ticket = await app.request("/auth/ws-ticket", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
    });
    expect(ticket.status).toBe(403);
  });
});
