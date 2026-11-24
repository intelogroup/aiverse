import assert from "node:assert/strict";
import postgres from "../../apps/gateway/node_modules/postgres/src/index.js";

const url = new URL(process.env.VERSE_LAB_DATABASE_URL ?? "postgres://postgres@127.0.0.1:5545/aiverse_test");
assert.ok(["127.0.0.1", "localhost"].includes(url.hostname) && url.pathname === "/aiverse_test");
const db = postgres(url.toString(), { max: 3, onnotice() {} });
const schema = db("greenfield_" + crypto.randomUUID().replaceAll("-", ""));
const trace: object[] = [];

try {
  await db`CREATE SCHEMA ${schema}`;
  // Fixtures are independent so each scenario can be scored against its own initial state.
  await db`CREATE TABLE ${schema}.parcel (
    id text PRIMARY KEY, courier text NOT NULL, recipient text NOT NULL, destination text NOT NULL, delivered boolean NOT NULL DEFAULT false
  )`;
  await db`INSERT INTO ${schema}.parcel VALUES ('parcel', 'courier', 'recipient', 'old-address', false)`;
  const redirect = (actor: string, destination: string) => db`
    UPDATE ${schema}.parcel SET destination = ${destination}
    WHERE id = 'parcel' AND recipient = ${actor} AND NOT delivered RETURNING id`;
  const deliver = (actor: string, destination: string) => db`
    UPDATE ${schema}.parcel SET delivered = true WHERE id = 'parcel'
    AND recipient = ${actor} AND destination = ${destination} AND NOT delivered RETURNING id`;
  assert.equal((await redirect("stranger", "wrong-address")).length, 0);
  assert.equal((await redirect("recipient", "new-address")).length, 1);
  assert.equal((await deliver("recipient", "old-address")).length, 0);
  assert.equal((await deliver("stranger", "new-address")).length, 0);
  const deliveryRace = await Promise.all([deliver("recipient", "new-address"), deliver("recipient", "new-address")]);
  assert.equal(deliveryRace.flat().length, 1);
  trace.push({ scenario: "parcel redirect", acceptedDeliveries: 1, staleAddressRejected: true, unauthorizedRedirectRejected: true });

  await db`CREATE TABLE ${schema}.stall (
    id text PRIMARY KEY, operator text NOT NULL, fee integer CHECK (fee BETWEEN 0 AND 10), term integer NOT NULL
  )`;
  await db`INSERT INTO ${schema}.stall VALUES ('stall', 'founder', 2, 1)`;
  assert.equal((await db`UPDATE ${schema}.stall SET operator='successor', term=2
    WHERE id='stall' AND operator='founder' AND term=1 RETURNING id`).length, 1);
  const fee = (actor: string, term: number, amount: number) => db`
    UPDATE ${schema}.stall SET fee=${amount}
    WHERE id='stall' AND operator=${actor} AND term=${term} AND ${amount}::integer BETWEEN 0 AND 10 RETURNING fee`;
  assert.equal((await fee("founder", 1, 4)).length, 0);
  assert.equal((await fee("successor", 2, 11)).length, 0);
  assert.equal((await fee("successor", 2, 4))[0]?.fee, 4);
  trace.push({ scenario: "night market succession", successorFee: 4, previousTermRejected: true, feeCapEnforced: true });

  await db`CREATE TABLE ${schema}.permit (
    holder text PRIMARY KEY, deadline integer NOT NULL, fulfilled boolean NOT NULL DEFAULT false
  )`;
  await db`INSERT INTO ${schema}.permit VALUES ('staff', 30, false), ('late-staff', 30, false)`;
  const fulfil = (actor: string, tick: number) => db`
    UPDATE ${schema}.permit SET fulfilled=true WHERE holder=${actor}
    AND ${tick}::integer < deadline AND NOT fulfilled RETURNING holder`;
  assert.equal((await fulfil("stranger", 29)).length, 0);
  assert.equal((await fulfil("staff", 29)).length, 1);
  assert.equal((await fulfil("staff", 29)).length, 0);
  assert.equal((await fulfil("late-staff", 30)).length, 0);
  trace.push({ scenario: "promises and keys", completedOnce: true, unauthorizedRejected: true, expiredRejected: true });

  await db`CREATE TABLE ${schema}.notice (
    revision integer PRIMARY KEY, supersedes integer REFERENCES ${schema}.notice(revision),
    author text NOT NULL, notice text NOT NULL, evidence text NOT NULL, embedding vector(3) NOT NULL
  )`;
  await db`INSERT INTO ${schema}.notice VALUES
    (1, NULL, 'district-clerk', 'District closed', 'initial-report', '[1,0,0]'),
    (2, 1, 'appeal-clerk', 'District reopened after appeal', 'verified-inspection', '[0.9,0.1,0]')`;
  await db`CREATE TABLE ${schema}.furnishing (
    room text NOT NULL, prop text NOT NULL, corner text NOT NULL, PRIMARY KEY(room, prop)
  )`;
  await db`INSERT INTO ${schema}.furnishing VALUES ('back-room', 'lamp', 'east')`;
  await db`UPDATE ${schema}.furnishing SET corner='west' WHERE room='back-room' AND prop='lamp'`;
  const reader = postgres(url.toString(), { max: 1 });
  try {
    const [notice] = await reader`SELECT n.revision, n.notice, n.evidence FROM ${schema}.notice n
      WHERE NOT EXISTS (SELECT 1 FROM ${schema}.notice later WHERE later.supersedes=n.revision)
      ORDER BY n.embedding <-> '[1,0,0]'::vector LIMIT 1`;
    assert.deepEqual(notice, { revision: 2, notice: "District reopened after appeal", evidence: "verified-inspection" });
    trace.push({ scenario: "durable notice and appeal", ...notice, readFromNewConnection: true, embedding: "synthetic fixture" });
    const [layout] = await reader`SELECT prop, corner FROM ${schema}.furnishing WHERE room='back-room'`;
    assert.deepEqual(layout, { prop: "lamp", corner: "west" });
    trace.push({ scenario: "the room that remembers", ...layout, readFromNewConnection: true });
  } finally {
    await reader.end();
  }

  await db`CREATE TABLE ${schema}.cue (
    id text PRIMARY KEY, performer text NOT NULL, status text NOT NULL CHECK (status IN ('scheduled', 'complete'))
  )`;
  await db`INSERT INTO ${schema}.cue VALUES ('first-cue', 'original', 'scheduled')`;
  assert.equal((await db`UPDATE ${schema}.cue SET performer='understudy'
    WHERE status='scheduled' AND performer='original' RETURNING id`).length, 1);
  const complete = (actor: string) => db`UPDATE ${schema}.cue SET status='complete'
    WHERE id='first-cue' AND performer=${actor} AND status='scheduled' RETURNING id`;
  assert.equal((await complete("original")).length, 0);
  assert.equal((await complete("understudy")).length, 1);
  assert.equal((await complete("understudy")).length, 0);
  trace.push({ scenario: "the show goes on", performer: "understudy", completions: 1, lateOriginalRejected: true });

  await db`CREATE TABLE ${schema}.demonstration (
    id text PRIMARY KEY, source_room text NOT NULL, steps text[] NOT NULL, owner_id text NOT NULL
  )`;
  await db`CREATE TABLE ${schema}.submission (
    demonstration text REFERENCES ${schema}.demonstration(id), trainee text NOT NULL, room text NOT NULL,
    steps text[] NOT NULL, accepted boolean NOT NULL DEFAULT false, PRIMARY KEY(demonstration, trainee)
  )`;
  await db`INSERT INTO ${schema}.demonstration VALUES ('tea-service', 'tea-house', ARRAY['take','serve','return'], 'owner')`;
  await db`INSERT INTO ${schema}.submission (demonstration, trainee, room, steps) VALUES
    ('tea-service', 'learner', 'market', ARRAY['take','serve','return']),
    ('tea-service', 'incomplete', 'market', ARRAY['take','serve'])`;
  const accept = (owner: string, trainee: string) => db`
    UPDATE ${schema}.submission s SET accepted=true FROM ${schema}.demonstration d
    WHERE d.id=s.demonstration AND d.owner_id=${owner} AND s.trainee=${trainee}
    AND s.room<>d.source_room AND s.steps=d.steps AND NOT s.accepted RETURNING s.room`;
  assert.equal((await accept("stranger", "learner")).length, 0);
  assert.equal((await accept("owner", "incomplete")).length, 0);
  assert.equal((await accept("owner", "learner"))[0]?.room, "market");
  assert.equal((await accept("owner", "learner")).length, 0);
  trace.push({ scenario: "a skill changes hands", source: "tea-house", replayRoom: "market", ownerAcceptances: 1, incompleteRejected: true });
  console.log(JSON.stringify({ scope: "scripted persistence prototypes", trace }, null, 2));
} finally {
  await db`DROP SCHEMA IF EXISTS ${schema} CASCADE`;
  await db.end();
}
