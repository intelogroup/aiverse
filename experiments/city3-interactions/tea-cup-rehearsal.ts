import assert from "node:assert/strict";
import postgres from "../../apps/gateway/node_modules/postgres/src/index.js";
import { loadVerseSim } from "../../packages/world-sim/node/loadWorld";
import { WorldService } from "../../packages/world-sim/src/worldService";

const databaseUrl = process.env.VERSE_LAB_DATABASE_URL;
const url = databaseUrl && new URL(databaseUrl);
if (!url || !["127.0.0.1", "localhost"].includes(url.hostname) || url.pathname !== "/aiverse_test") {
  throw new Error("Set VERSE_LAB_DATABASE_URL to the local aiverse_test database.");
}
const sql = postgres(databaseUrl!, { max: 3, onnotice() {} });
const schema = sql("cup_lab_" + crypto.randomUUID().replaceAll("-", ""));
const assets = new URL("../../apps/console/public/assets/", import.meta.url).pathname;
const { sim } = await loadVerseSim(assets);
const world = new WorldService({ sim });
const trace: unknown[] = [];
const cup = "tea-lab-cup";
const spot = [-26.4, -75.2] as const;
const actorIds = ["host", "visitor", "replacement"];
function event(kind: string, detail: object) {
  trace.push({ kind, simTime: sim.t, ...detail });
}
function pose(id: string) {
  const view = world.observe(id);
  return { ...view.body, room: view.insideRoom };
}
async function action(actor: string, intent: Record<string, unknown>) {
  const act = world.act(actor, crypto.randomUUID(), intent);
  let clip: string | null = null;
  let sampleAt = sim.t;
  for (let t = 0; act.state === "running" && t < 45; t += 0.05) {
    world.tick(0.05);
    await Promise.resolve();
    const sample = world.body(actor);
    if (sim.t >= sampleAt) {
      event("poses", { bodies: actorIds.filter(id => world.has(id)).map(id => world.body(id)) });
      sampleAt += 0.1;
    }
    if (sample.clip !== clip) {
      clip = sample.clip;
      event("clip", { actor, clip, pose: sample });
    }
  }
  event("world_action", { actor, intent, outcome: act.outcome, pose: pose(actor) });
  assert.equal(act.outcome?.ok, true, JSON.stringify({ actor, intent, outcome: act.outcome }));
}
function near(actor: string, target?: string) {
  const a = pose(actor);
  const b = target ? pose(target) : { x: spot[0], z: spot[1], room: a.room };
  return a.room === "Matchmaker's Tea House" && a.room === b.room && Math.hypot(a.x - b.x, a.z - b.z) <= 2;
}
type Command = "take" | "transfer" | "set_down" | "recover" | "drink";
async function custody(id: string, command: Command, actor: string, recipient?: string) {
  return sql.begin(async tx => {
    const [state] = await tx`SELECT holder, drinks FROM ${schema}.cup WHERE id=${cup} FOR UPDATE`;
    const [prior] = await tx`SELECT result FROM ${schema}.receipt WHERE id=${id}`;
    if (prior) {
      assert.deepEqual(prior.result.intent, { command, actor, recipient: recipient ?? null });
      event("replayed", { id });
      return prior.result;
    }
    let holder = state.holder as string | null;
    let drinks = state.drinks as number;
    const live = world.has(actor);
    let ok = false;
    if (command === "take" && holder === null && live && near(actor)) {
      holder = actor; ok = true;
    } else if (command === "transfer" && holder === actor && live && recipient && world.has(recipient) && near(actor, recipient)) {
      holder = recipient; ok = true;
    } else if (command === "set_down" && holder === actor && live && near(actor)) {
      holder = null; ok = true;
    } else if (command === "recover" && holder === actor && !live) {
      holder = null; ok = true;
    } else if (command === "drink" && holder === actor && live) {
      drinks++; ok = true;
    }
    if (ok) await tx`UPDATE ${schema}.cup SET holder=${holder}, drinks=${drinks} WHERE id=${cup}`;
    const result = { intent: { command, actor, recipient: recipient ?? null }, ok, holder, drinks };
    await tx`INSERT INTO ${schema}.receipt (id,result) VALUES (${id},${sql.json(result)})`;
    return result;
  }).then(result => {
    event("custody", { id, cup, ...result });
    return result;
  });
}
async function enter(id: string, figure: string, point: [number, number]) {
  world.attach(id, { x: -22.92, z: -68.5, heading: Math.PI }, figure);
  await action(id, { type: "enter", place: "tea" });
  await action(id, { type: "go_to", point });
}
try {
  const [version] = await sql`SELECT extversion FROM pg_extension WHERE extname='vector'`;
  assert.ok(version, "pgvector must be enabled");
  await sql`CREATE SCHEMA ${schema}`;
  await sql`CREATE TABLE ${schema}.cup (id text PRIMARY KEY, holder text, drinks integer NOT NULL DEFAULT 0)`;
  await sql`CREATE TABLE ${schema}.receipt (id text PRIMARY KEY, result jsonb NOT NULL)`;
  await sql`INSERT INTO ${schema}.cup (id) VALUES (${cup})`;
  await enter("host", "summer", [-27, -75.65]);
  await enter("visitor", "remy", [-27.45, -76.26]);
  assert.ok(near("host") && near("visitor") && near("host", "visitor"));
  assert.equal((await custody("pickup", "take", "host")).holder, "host");
  assert.equal((await custody("pickup", "take", "host")).holder, "host");
  assert.equal((await custody("occupied", "take", "visitor")).ok, false);
  assert.equal((await custody("handoff", "transfer", "host", "visitor")).holder, "visitor");
  await action("visitor", { type: "play", clip: "Drinking" });
  assert.equal((await custody("sip", "drink", "visitor")).drinks, 1);
  assert.equal((await custody("sip", "drink", "visitor")).drinks, 1);
  assert.equal((await custody("return", "set_down", "visitor")).holder, null);
  const race = await Promise.all([custody("race-host", "take", "host"), custody("race-visitor", "take", "visitor")]);
  assert.equal(race.filter(r => r.ok).length, 1);
  const winner = race.find(r => r.ok)!.holder!;
  assert.equal(world.detach(winner), true);
  event("detached", { actor: winner });
  assert.equal((await custody("recovery", "recover", winner)).holder, null);
  // Clear the remaining actor before staging the incoming replacement.
  for (const id of actorIds) world.detach(id);
  await enter("replacement", "eve", [-27, -75.65]);
  assert.equal((await custody("replacement-take", "take", "replacement")).holder, "replacement");
  assert.equal((await custody("replacement-return", "set_down", "replacement")).holder, null);
  const [final] = await sql`SELECT holder,drinks FROM ${schema}.cup WHERE id=${cup}`;
  assert.deepEqual(final, { holder: null, drinks: 1 });
  console.log(JSON.stringify({ pgvector: version.extversion, cup, tabletop: { x: spot[0], z: spot[1] }, final, trace }, null, 2));
} catch (error) {
  console.error(JSON.stringify(trace.slice(-8), null, 2));
  throw error;
} finally {
  for (const id of actorIds) world.detach(id);
  await sql`DROP SCHEMA IF EXISTS ${schema} CASCADE`;
  await sql.end();
}
