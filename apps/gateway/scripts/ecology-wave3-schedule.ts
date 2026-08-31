// Wave 3 disconnect schedule generator (Amendment 1 A1.3).
//
// Writes experiments/verse-ecology/wave-3-disconnects.json deterministically
// from seed 774193021 BEFORE Wave 1 begins. Which Wave 3 agents disconnect,
// at which tick, and for how long are frozen data; the orchestrator reads
// this file and never decides a disconnect from what happened socially.
//
// Deliberately NOT frozen: any specific thread. The detection condition —
// "at least one new public thread/activity event occurs while the selected
// agent is disconnected" — is evaluated during analysis. Picking the thread
// here would make this scheduler an information channel to the returning
// agent.
//
// Independent per-attribute mulberry32 streams (offsets 5 and 6) so this
// generator cannot shift any population draw, and future additions cannot
// shift these.
//
// Usage: bun run apps/gateway/scripts/ecology-wave3-schedule.ts

const SEED = 774193021;
const OUT = "experiments/verse-ecology/wave-3-disconnects.json";

// Must match ecology-wave.ts wave-3 constants exactly.
const WAVE3_SIZE = 8;
const TICKS = Number(process.argv[2] ?? 200);

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rWho = rng(SEED + 3000 + 5); // wave-3 offset + stream 5
const rWhen = rng(SEED + 3000 + 6); // wave-3 offset + stream 6
const rAbsent = rng(SEED + 3000 + 7);

// How many of the 8 disconnect: between 2 and 4 — enough return events to
// measure re-entry, few enough that the wave still accumulates world state.
const count = 2 + Math.floor(rWho() * 3);

// Pick distinct members.
const pool = Array.from({ length: WAVE3_SIZE }, (_, i) => `EcoW3-${i + 1}`);
const chosen: string[] = [];
while (chosen.length < count && pool.length > 0) {
  chosen.push(pool.splice(Math.floor(rWho() * pool.length), 1)[0]);
}

// Disconnect window: never before tick 30 (agents need established context
// to return to) and never so late that the return segment is too short to
// observe (at least 40 ticks after reconnect).
const minDisconnect = 30;
const maxDisconnect = TICKS - 40 - 20; // -20: minimum absence
const disconnects = chosen.map((name) => {
  const disconnect_at_tick = minDisconnect + Math.floor(rWhen() * (maxDisconnect - minDisconnect));
  // Absence: 20–80 ticks — long enough that the world moves, short enough
  // that persistent context is plausibly still relevant.
  const absent_ticks = 20 + Math.floor(rAbsent() * 61);
  return { name, disconnect_at_tick, absent_ticks };
});

disconnects.sort((a, b) => a.disconnect_at_tick - b.disconnect_at_tick);

const schedule = {
  generated: new Date().toISOString(),
  seed: SEED,
  wave: 3,
  ticks: TICKS,
  // Frozen condition, not a frozen thread: whether each disconnected agent's
  // absence window contained >= 1 new public thread/activity event is
  // evaluated at analysis time from the export, never here.
  detection_condition: "at least one new public thread/activity event during absence",
  reconnect_semantics: "WS close (process termination); same agent identity and token; backlog replay on reconnect",
  disconnects,
};

await Bun.write(OUT, JSON.stringify(schedule, null, 2) + "\n");
console.log(`frozen schedule written to ${OUT}: ${disconnects.length} disconnects`);
for (const d of disconnects) console.log(`  ${d.name}: disconnect at tick ${d.disconnect_at_tick}, absent ${d.absent_ticks} ticks`);