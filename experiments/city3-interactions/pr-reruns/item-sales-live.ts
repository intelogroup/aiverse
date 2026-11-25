// Run from repo root with a migrated disposable aiverse_sales_* Postgres DB.
// Requires local Redis DB 13. Services use ephemeral loopback ports.
import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { SIM_API_VERSION } from "../../../apps/gateway/src/world/simClient";

const database = new URL(process.env.DATABASE_URL ?? "");
assert(["localhost", "127.0.0.1"].includes(database.hostname) &&
  /^\/aiverse_sales_[a-z0-9_]+$/.test(database.pathname), "Use a disposable local aiverse_sales_* database");
const reserves = [0, 0].map((port) => Bun.serve({ port, hostname: "127.0.0.1", fetch: () => new Response() }));
const [gatewayPort, simPort] = reserves.map((server) => String(server.port));
reserves.forEach((server) => server.stop(true));
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
const simUrl = `http://127.0.0.1:${simPort}`;
const simSecret = crypto.randomUUID();
const env = {
  PATH: process.env.PATH ?? "", NODE_ENV: "development",
  DATABASE_URL: database.href, DATABASE_URL_DIRECT: database.href,
  REDIS_URL: "redis://127.0.0.1:6379/13", JWT_SECRET: crypto.randomUUID(),
  AIVERSE_DISABLE_NATIVES: "1", AIVERSE_WORLD_MODE: "1", AIVERSE_VERSE_PROGRESS: "1",
  SIM_URL: simUrl, SIM_INTERNAL_SECRET: simSecret, SIM_AMBIENT: "0", SIM_PORT: simPort, PORT: gatewayPort,
};
const temp = await import("node:fs/promises");
const logs = await temp.mkdtemp("/tmp/aiverse-item-sales-");
console.log(`Service logs: ${logs}`);

function start(service: "sim" | "gateway", suffix = "") {
  const logfile = Bun.file(`${logs}/${service}${suffix}.log`);
  return Bun.spawn([process.execPath, "--no-env-file", "run", "src/index.ts"], {
    cwd: `apps/${service}`, env, stdout: logfile, stderr: "inherit",
  });
}

async function stop(proc?: ReturnType<typeof start>) {
  if (!proc) return;
  proc.kill();
  await proc.exited;
}

async function ready(url: string, proc: ReturnType<typeof start>, token?: string) {
  for (let i = 0; i < 120 && proc.exitCode === null; i++) {
    const response = await fetch(url, {
      headers: token ? { authorization: `Bearer ${token}`, "x-sim-api": String(SIM_API_VERSION) } : {},
      signal: AbortSignal.timeout(500),
    }).catch(() => undefined);
    if (response?.ok) return;
    await Bun.sleep(250);
  }
  throw new Error(`Service not ready: ${url} (exit ${proc.exitCode})`);
}

async function api(path: string, token?: string, body?: object, expected?: number, method = body === undefined ? "GET" : "POST") {
  const response = await fetch(gatewayUrl + path, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const data = await response.json();
  if (expected !== undefined) assert.equal(response.status, expected, `${path}: ${JSON.stringify(data)}`);
  return { status: response.status, data };
}

const run = crypto.randomUUID().slice(0, 8);
const password = `Local-${crypto.randomUUID()}`;
async function login(email: string) {
  return (await api("/owners/login", undefined, { email, password }, 200)).data.token as string;
}

async function pickup(role: string) {
  const email = `sales-${run}-${role}@example.com`;
  await api("/owners/register", undefined, { email, password }, 201);
  const owner = await login(email);
  const { data: { agent, agentToken } } = await api("/owners/agents", owner, { name: `Sale-${run}-${role}` }, 201);
  const { data: { visit } } = await api(`/owners/agents/${agent.id}/visits`, owner, { minutes: 5, maxActions: 30 }, 201);
  // Stage fixtures at the hall approach so the sale regression does not depend on cross-city routing.
  const placed = await fetch(simUrl + "/bodies", {
    method: "POST",
    headers: { authorization: `Bearer ${simSecret}`, "x-sim-api": String(SIM_API_VERSION), "content-type": "application/json" },
    body: JSON.stringify({ agentId: agent.id, expiresAtMs: Date.now() + 300_000, spawn: { x: 34.5, z: -74 } }),
  });
  assert.equal(placed.status, 201, await placed.text());
  await api("/world/body", agentToken, {}, 200);
  async function act(id: string, action: object) {
    await api("/world/act", agentToken, { id, action }, 202);
    for (let tick = 0; tick < 240; tick++) {
      const { data: { act: current } } = await api(`/world/act/${id}`, agentToken, undefined, 200);
      if (current.state === "settled") {
        assert.equal(current.outcome?.ok, true, `${role} ${id}: ${JSON.stringify(current.outcome)}`);
        return;
      }
      await Bun.sleep(500);
    }
    throw new Error(`${role} ${id} did not settle`);
  }
  await act("sales-enter-hall", { type: "enter", place: "hall-0" });
  const pickupId = "market-hall-bakery-sample";
  await act("sales-sample", { type: "interact", target: pickupId });
  const { data: { reward } } = await api("/world/pickup", agentToken, { actId: "sales-sample", pickupId }, 200);
  assert.equal(reward.credits, 1);
  console.log(`${role}: entered Market Hall and earned 1 credit from the bakery pickup`);
  await api("/world/body", agentToken, undefined, 200, "DELETE");
  return { id: agent.id as string, email, owner, visitId: visit.id as string, agentToken: agentToken as string, item: reward.itemId as string };
}

let sim: ReturnType<typeof start> | undefined;
let gateway: ReturnType<typeof start> | undefined;
try {
  sim = start("sim");
  await ready(simUrl + "/healthz", sim, simSecret);
  gateway = start("gateway");
  await ready(gatewayUrl + "/health", gateway);
  // Sequential travel keeps the three scripted fixtures from blocking one another.
  const seller = await pickup("seller");
  const first = await pickup("first");
  const second = await pickup("second");
  const { data: { offer } } = await api("/verse/sales", seller.agentToken, { itemId: seller.item, revision: 0, price: 1 }, 200);
  const buy = (agent: typeof first) => api(`/verse/sales/${offer.id}/buy`, agent.agentToken, {});
  const results = await Promise.all([buy(first), buy(second)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const [winner, loser] = results[0].status === 200 ? [first, second] : [second, first];
  const receipt = results.find((r) => r.status === 200)!.data;
  assert.deepEqual(await buy(winner), { status: 200, data: receipt });
  const readInventory = async (agent: typeof first) =>
    (await api(`/owners/agents/${agent.id}/inventory`, await login(agent.email), undefined, 200)).data;
  const agents = [seller, winner, loser];
  const before = await Promise.all(agents.map(readInventory));
  assert.deepEqual(before.map((bag) => bag.progress.credits), [2, 0, 1]);
  assert.deepEqual(before.map((bag) => bag.items.some((item: { id: string }) => item.id === seller.item)), [false, true, false]);
  assert.deepEqual(before.map((bag) => bag.receipts.map((row: { side: string }) => row.side)), [["sold"], ["bought"], []]);

  await Promise.all(agents.map((agent) =>
    api(`/owners/agents/${agent.id}/visits/${agent.visitId}/stop`, agent.owner, {}, 200)));
  const previousPid = gateway.pid;
  await stop(gateway);
  gateway = start("gateway", "-restart");
  assert.notEqual(gateway.pid, previousPid);
  await ready(gatewayUrl + "/health", gateway);
  const winnerOwner = await login(winner.email);
  await api(`/owners/agents/${winner.id}/visits`, winnerOwner, { minutes: 5, maxActions: 30 }, 201);
  await api("/world/body", winner.agentToken, {}, 201);
  const after = await Promise.all(agents.map(readInventory));
  assert(isDeepStrictEqual(after, before), "Inventory, credits, XP, or receipts changed across gateway restart");
  assert.deepEqual(await buy(winner), { status: 200, data: receipt });
  console.log("PASS: real pickups, concurrent sale, credit conservation, and identical inventories and receipts after gateway restart");
} finally {
  await stop(gateway);
  await stop(sim);
}
