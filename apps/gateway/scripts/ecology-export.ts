// Ecology wave teardown: export → verify → THEN clean. Never delete first.
// (Amendment 1 A1.4 strengthens the pilot's pipeline.)
//
// The pilot's episode-export lost three episodes of transcripts by deleting by
// author NAME before a verified export existed, and its verifier checked a
// single count. This script:
//
//   1. EXPORT (read only) — wave manifest, per-agent decision logs, security
//      events, messages (wave agents AND full in-thread context), participants,
//      A2A tasks, and an environment/public-surface snapshot.
//   2. VERIFY — every section must exist and agree with a live recount from
//      the database, and every manifest agent must be present. Any mismatch
//      aborts before any deletion; a wave whose export fails verification is
//      RERUN, not interpreted.
//   3. CLEAN — deletes ONLY rows scoped by the provisioned agent/owner UUIDs
//      read from the wave manifest. Never by name, never by status, never by
//      a run_id/ecology_wave tag (those exist for forensic queries only).
//      Rows belonging to agents outside the manifest (natives, earlier waves
//      still accumulating, decoys) are never touched. Conversations created
//      solely by cleaned agents are removed; shared threads keep their
//      non-wave content.
//
// Usage:
//   DATABASE_URL=... bun run apps/gateway/scripts/ecology-export.ts <wave:1|2|3|control> [outDir]

import postgres from "postgres";
import { computeEnvFingerprint, canonicalize } from "./ecology-env-fingerprint";

const [wave, outDir = "experiments/verse-ecology/runs"] = process.argv.slice(2);
const url = process.env.DATABASE_URL;
if (!url || !wave || !["1", "2", "3", "control", "e2a", "e2b", "e2c", "e2d", "e2e", "nano-test", "nano2", "nano3", "nano4", "eager", "eager2", "observers", "pa2"].includes(wave)) {
  console.error("usage: ecology-export.ts <1|2|3|control|e2a|e2b|e2c|e2d|e2e> [outDir]");
  process.exit(1);
}

const manifestPath = `${outDir}/wave-${wave}-manifest.jsonl`;
const CLEAN_DRY = process.argv.includes("--clean-dry");
if (!(await Bun.file(manifestPath).exists())) {
  console.error(`manifest missing: ${manifestPath} — nothing to export`);
  process.exit(1);
}
const manifest = (await Bun.file(manifestPath).text())
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

if (manifest.some((m: any) => m.dry_run) && !CLEAN_DRY) {
  console.error("manifest contains dry_run rows — dry runs are never exported or cleaned (use --clean-dry to remove their residue without exporting)");
  process.exit(1);
}
const expectedSize = { "1": 10, "2": 8, "3": 8, control: 5, e2a: 3, e2b: 4, e2c: 20, e2d: 20, e2e: 20, "nano-test": 5, nano2: 5, nano3: 3, nano4: 3, eager: 5, eager2: 5, observers: 5, pa2: 5 }[wave as "1" | "2" | "3" | "control" | "e2a" | "e2b" | "e2c" | "e2d" | "e2e" | "nano-test" | "nano2" | "nano3" | "nano4" | "eager" | "eager2" | "observers" | "pa2"];
if (manifest.length !== expectedSize) {
  console.error(`manifest has ${manifest.length} rows, expected ${expectedSize} — wave incomplete, refusing`);
  process.exit(1);
}

const agentIds = manifest.map((m: any) => m.agent_id);
const ownerIds = manifest.map((m: any) => m.owner_id);
const idList = agentIds.map((id: string) => `${id}`);

const sql = postgres(url, { max: 1 });

if (CLEAN_DRY) {
  // Dry-run residue cleanup. No export, no verify, no corpus: a dry run is
  // never analysable. Deletion stays scoped to the manifest UUIDs exactly as
  // in the real path, and this exercises the same cleanup SQL.
  console.log("clean-dry: skipping export/verify — dry-run data are never analysable");
} else {
// ---- 1. EXPORT (read only)

const agentsRows = await sql`
  SELECT id, owner_id, name, status, agent_card, created_at FROM agents WHERE id = ANY(${idList})`;
const events = await sql`
  SELECT s.event, s.created_at, s.agent_id
  FROM security_events s WHERE s.agent_id = ANY(${idList}) ORDER BY s.created_at`;
// Messages authored by wave agents, and everything said IN conversations the
// wave's agents touched — a transcript missing the other side is not a transcript.
const waveMessages = await sql`
  SELECT m.id, m.conversation_id, m.sender_agent_id, m.content, m.reply_to_id, m.created_at
  FROM messages m WHERE m.sender_agent_id = ANY(${idList}) ORDER BY m.created_at`;
const threadContext = await sql`
  SELECT m.id, m.conversation_id, m.sender_agent_id, m.content, m.reply_to_id, m.created_at
  FROM messages m WHERE m.conversation_id IN (
    SELECT cp.conversation_id FROM conversation_participants cp
    WHERE cp.agent_id = ANY(${idList}))
  ORDER BY m.created_at`;
const participants = await sql`
  SELECT cp.conversation_id, cp.agent_id, cp.joined_at
  FROM conversation_participants cp WHERE cp.agent_id = ANY(${idList})`;
const a2a = await sql`
  SELECT t.* FROM a2a_tasks t
  WHERE t.caller_agent_id = ANY(${idList}) OR t.target_agent_id = ANY(${idList})`;
const [{ discoverable }] = await sql`SELECT count(*)::int AS discoverable FROM agents WHERE status != 'unclaimed'`;
const [{ online }] = await sql`SELECT count(*)::int AS online FROM agents WHERE status = 'online'`;
// Public-surface snapshot at export time: the threads a newcomer could have perceived.
const publicThreads = await sql`
  SELECT c.id, c.created_at,
         (SELECT count(*)::int FROM messages m WHERE m.conversation_id = c.id) AS message_count
  FROM conversations c WHERE c.is_public = true ORDER BY c.created_at`;

// Decision logs: read back from disk, not trusted from the manifest.
const decisionLogs: Record<string, string[]> = {};
for (const m of manifest) {
  decisionLogs[m.name] = (await Bun.file(m.log).exists())
    ? (await Bun.file(m.log).text()).split("\n").filter(Boolean)
    : [];
}

const bundle = {
  wave,
  run_id: manifest[0]?.run_id ?? null,
  seed: manifest[0]?.seed ?? null,
  exported_at: new Date().toISOString(),
  environment: {
    discoverable_agents: discoverable,
    online_agents: online,
    public_thread_count: publicThreads.length,
  },
  manifest,
  agents: agentsRows,
  decision_logs: decisionLogs,
  wave_messages: waveMessages,
  conversation_context: threadContext,
  participants,
  a2a_tasks: a2a,
  security_events: events,
  public_threads_snapshot: publicThreads,
};

const exportPath = `${outDir}/wave-${wave}-export.json`;
await Bun.write(exportPath, JSON.stringify(bundle, null, 2));

// ---- 2. VERIFY (every section against a live recount)

const readBack = JSON.parse(await Bun.file(exportPath).text());
const [{ msgCount }] = await sql`
  SELECT count(*)::int AS "msgCount" FROM messages WHERE sender_agent_id = ANY(${idList})`;
const [{ eventCount }] = await sql`
  SELECT count(*)::int AS "eventCount" FROM security_events WHERE agent_id = ANY(${idList})`;
const [{ a2aCount }] = await sql`
  SELECT count(*)::int AS "a2aCount" FROM a2a_tasks
  WHERE caller_agent_id = ANY(${idList}) OR target_agent_id = ANY(${idList})`;
const [{ participantCount }] = await sql`
  SELECT count(*)::int AS "participantCount" FROM conversation_participants WHERE agent_id = ANY(${idList})`;

const decisionLineTotal = Object.values(decisionLogs).reduce((n, lines) => n + lines.length, 0);
const logLineTotal = manifest.reduce((n: number, m: any) => n + (readBack.decision_logs[m.name] ?? []).length, 0);

// Fingerprint comparison — the load-bearing half of the fingerprint design.
// The export REGENERATES the fingerprint from the current environment and
// requires it to be byte-identical to what the orchestrator embedded in the
// manifest and to the header record in every decision log. Without this
// second comparison the fingerprint would be decorative metadata.
// Any drift — code, config, DB/extension/Redis version, resolved model,
// natives flag — fails verification, and nothing is cleaned.
const manifestFp = manifest[0]?.env_fingerprint ?? null;
const manifestFpsIdentical = manifest.every((m: any) => canonicalize(m.env_fingerprint ?? null) === canonicalize(manifestFp));
let regenFp: Record<string, unknown> | null = null;
let regenError: string | null = null;
try {
  regenFp = await computeEnvFingerprint({ wave, runId: manifest[0]?.run_id ?? "unknown" });
} catch (e) {
  regenError = String(e);
}
const fpMatches = !!regenFp && !!manifestFp && canonicalize(regenFp) === canonicalize(manifestFp);

// Every decision log must open with the fingerprint header record, and it
// must equal the regenerated fingerprint.
let headersOk = !!regenFp;
const headerDetails: string[] = [];
if (regenFp) {
  for (const m of manifest) {
    const lines = decisionLogs[m.name] ?? [];
    let first: any = null;
    try {
      first = lines.length ? JSON.parse(lines[0]) : null;
    } catch {
      first = null;
    }
    if (first?.record_type !== "env_fingerprint" || canonicalize(first.fingerprint) !== canonicalize(regenFp)) {
      headersOk = false;
      headerDetails.push(m.name);
    }
  }
}

const checks: [string, boolean][] = [
  ["export file readable", readBack.wave === wave],
  ["every manifest agent present in db", readBack.agents.length === manifest.length],
  ["wave messages match db", readBack.wave_messages.length === msgCount],
  ["thread context superset of wave messages", readBack.conversation_context.length >= readBack.wave_messages.length],
  ["participants match db", readBack.participants.length === participantCount],
  ["security events match db", readBack.security_events.length === eventCount],
  ["a2a tasks match db", readBack.a2a_tasks.length === a2aCount],
  ["decision logs read back intact", decisionLineTotal === logLineTotal && decisionLineTotal > 0],
  ["manifest carries one identical env fingerprint", !!manifestFp && manifestFpsIdentical],
  ["fingerprint regenerates identically", fpMatches],
  ["decision-log fingerprint headers match", headersOk],
];

let ok = true;
for (const [name, passed] of checks) {
  console.log(`  ${passed ? "OK  " : "FAIL"} ${name}`);
  if (!passed) ok = false;
}
if (!ok) {
  if (regenError) console.error(`fingerprint regeneration error: ${regenError}`);
  if (headerDetails.length) console.error(`fingerprint header mismatch in: ${headerDetails.join(", ")}`);
  console.error(`EXPORT VERIFY FAILED for wave ${wave} — refusing to clean. The wave is rerun, not interpreted.`);
  await sql.end();
  process.exit(1);
}

console.log(`export verified: ${exportPath}`);
}

// ---- 3. CLEAN (only now, only by manifest UUIDs)

// Conversations created solely by wave agents (no participant outside the
// manifest) can go; shared threads keep their non-wave content and members.
const conversationsToDrop: { id: string }[] = await sql`
  SELECT DISTINCT cp.conversation_id AS id
  FROM conversation_participants cp
  WHERE cp.conversation_id NOT IN (
    SELECT conversation_id FROM conversation_participants
    WHERE agent_id != ALL(${idList}))`;
const dropIds = conversationsToDrop.map((r) => r.id);

// Message-derived rows (classifier outputs, entities, topics) reference
// messages by FK with no cascade — delete them for every message about to
// disappear, BEFORE the messages themselves.
const doomedMessages: { id: string }[] = await sql`
  SELECT id FROM messages
  WHERE sender_agent_id = ANY(${idList}) OR conversation_id = ANY(${dropIds}::uuid[])`;
const doomedIds = doomedMessages.map((r) => r.id);
if (doomedIds.length > 0) {
  await sql`DELETE FROM message_sentiment WHERE message_id = ANY(${doomedIds}::uuid[])`;
  await sql`DELETE FROM message_entities WHERE message_id = ANY(${doomedIds}::uuid[])`;
  await sql`DELETE FROM message_topics WHERE message_id = ANY(${doomedIds}::uuid[])`;
}
await sql`DELETE FROM messages WHERE sender_agent_id = ANY(${idList})`;
await sql`DELETE FROM messages WHERE conversation_id = ANY(${dropIds}::uuid[])`;
await sql`DELETE FROM conversation_participants WHERE agent_id = ANY(${idList})`;
await sql`DELETE FROM conversations WHERE id = ANY(${dropIds}::uuid[])`;
await sql`DELETE FROM a2a_tasks WHERE caller_agent_id = ANY(${idList}) OR target_agent_id = ANY(${idList})`;
// Every other agent-keyed table (FKs exist or plain uuid columns), scoped to
// the manifest ids. Deleting the agents without these first would either
// violate an FK or strand orphaned rows.
await sql`DELETE FROM agent_mandates WHERE agent_id = ANY(${idList})`;
await sql`DELETE FROM agent_memory WHERE agent_id = ANY(${idList})`;
await sql`DELETE FROM wallet_usage_daily WHERE agent_id = ANY(${idList})`;
await sql`DELETE FROM console_events WHERE agent_id = ANY(${idList})`;
await sql`DELETE FROM task_outcomes WHERE caller_agent_id = ANY(${idList}) OR target_agent_id = ANY(${idList})`;
await sql`DELETE FROM goals WHERE agent_id = ANY(${idList}) OR owner_id = ANY(${ownerIds})`;
await sql`DELETE FROM agent_wallets WHERE agent_id = ANY(${idList})`;
await sql`DELETE FROM agent_policy_scope WHERE agent_id = ANY(${idList})`;
await sql`DELETE FROM security_events WHERE agent_id = ANY(${idList})`;
await sql`DELETE FROM agents WHERE id = ANY(${idList})`;
await sql`DELETE FROM owners WHERE id = ANY(${ownerIds})`;

console.log("world cleaned — scoped exclusively to manifest UUIDs");
await sql.end();