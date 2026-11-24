import assert from "node:assert/strict";
import postgres from "../../apps/gateway/node_modules/postgres/src/index.js";
import { loadVerseSim } from "../../packages/world-sim/node/loadWorld";
import { WorldService } from "../../packages/world-sim/src/worldService";

const { sim } = await loadVerseSim(new URL("../../apps/console/public/assets/", import.meta.url).pathname);
const world = new WorldService({ sim });
const start = sim.places.find(p => p.id === "stall-40")!.stand;
const villa = sim.places.find(p => p.id === "villa");
assert.ok(villa, "This experiment needs the Villa landmark and rebaked dam collision. See pr-reruns/README.md.");
const goal = villa.stand;
const dbUrl = process.env.VERSE_LAB_DATABASE_URL;
assert.ok(dbUrl, "Set VERSE_LAB_DATABASE_URL to your local aiverse_test database");
const url = new URL(dbUrl);
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/aiverse_test");
const db = postgres(dbUrl, { max: 3, onnotice() {} });
const schema = db("parcel_lab_" + crypto.randomUUID().replaceAll("-", ""));
const track = [];
async function step() {
  world.tick(1 / 60);
  await Promise.resolve();
}
try {
  await db`CREATE SCHEMA ${schema}`;
  await db`CREATE TABLE ${schema}.parcel (
    id text PRIMARY KEY, destination text NOT NULL, delivered_by text, delivered_to text
  )`;
  await db`INSERT INTO ${schema}.parcel VALUES ('villa-parcel', 'old-desk')`;
  world.attach("courier", { x: start[0], z: start[1] }, "remy");
  const initial = world.act("courier", "original-route", { type: "go_to", place: "shop-102" });
  for (let i = 0; i < 180; i++) await step();
  const before = world.body("courier");
  assert.equal(initial.state, "running");
  assert.ok(Math.hypot(before.x - start[0], before.z - start[1]) > 1);
  world.attach("dispatcher", { x: before.x + 2, z: before.z }, "cipher");
  const notice = "Redirect parcel villa-parcel to The Villa, map place villa.";
  const spoken = world.act("dispatcher", "redirect-notice", { type: "say", text: notice });
  assert.equal(spoken.outcome?.ok, true);
  const heard = world.observe("courier").heard.find(line => line.text === notice);
  assert.ok(heard, "courier must actually hear the redirect");
  const [redirect] = await db`UPDATE ${schema}.parcel SET destination='villa'
    WHERE id='villa-parcel' AND destination='old-desk' RETURNING id, destination`;
  assert.ok(redirect);
  world.act("courier", "cancel-old-route", { type: "stop" });
  await step();
  const delivery = world.act("courier", "villa-route", { type: "go_to", place: "villa" });
  for (let i = 0; i < 60 * 360 && delivery.state === "running"; i++) {
    await step();
    if (i % 30 === 0) {
      const { x, y, z } = world.body("courier");
      track.push({ t: sim.t, x, y, z });
    }
  }
  const end = world.body("courier");
  assert.ok(delivery.outcome?.ok);
  assert.ok(Math.hypot(end.x - goal[0], end.z - goal[1]) < 1);
  world.attach("recipient", { x: end.x + 2, z: end.z }, "eve");
  const acknowledgement = "I received parcel villa-parcel at The Villa.";
  world.act("recipient", "acknowledge-parcel", { type: "say", text: acknowledgement });
  assert.ok(world.observe("courier").heard.some(line => line.text === acknowledgement));
  const commit = () => db`UPDATE ${schema}.parcel SET delivered_by='courier', delivered_to='recipient'
    WHERE id='villa-parcel' AND destination='villa' AND delivered_to IS NULL RETURNING *`;
  const writes = (await Promise.all([commit(), commit()])).flat();
  assert.equal(writes.length, 1);
  console.log(JSON.stringify({ originalRoute: initial.outcome, before, heard, end, arrived: delivery.outcome, acknowledgement, receipt: writes[0], track }, null, 2));
} finally {
  await db`DROP SCHEMA IF EXISTS ${schema} CASCADE`;
  await db.end();
}
