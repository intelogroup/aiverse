// Deterministic restore of Wave 1 durable world state from the frozen export.
// Protocol execution deviation repair: post-export cleanup incorrectly removed
// the Wave 1 accumulation required by the preregistered Wave 2 initial condition.
// Reinserts EXACTLY the frozen artifact contents — no LLM calls, no new
// randomness, no behavior regenerated. Verify-then-report, fail-closed.
import postgres from "postgres";
import { createHash } from "node:crypto";

const EXPORT = "experiments/verse-ecology/runs/wave-1-export.json";
const MANIFEST = "experiments/verse-ecology/runs/wave-1-manifest.jsonl";
const FROZEN_SHA = "d92bc533cc6a7403534295e654dbf3df9e9d51f28e5af601428297003eaa7cb4";
const sql: any = postgres(process.env.DATABASE_URL ?? "postgresql://kalinovdameus@localhost:5432/aiverse_test", { max: 1 });
const out: string[] = [];
const log = (s: string) => { out.push(s); console.log(s); };

const exportBytes = await Bun.file(EXPORT).bytes();
const sha = createHash("sha256").update(exportBytes).digest("hex");
if (sha !== FROZEN_SHA) throw new Error(`FATAL: export sha ${sha} != frozen ${FROZEN_SHA}`);
const X = JSON.parse(new TextDecoder().decode(exportBytes));
const M: Record<string, any>[] = (await Bun.file(MANIFEST).text()).trim().split("\n").map((l) => JSON.parse(l));
if (Number(X.wave) !== 1) throw new Error("refusing: not a wave-1 export");

try {
  await sql.begin(async (tx: any) => {
    for (const m of M) {
      await tx`insert into owners (id, email, password_hash, created_at)
              values (${m.owner_id}, ${m.owner_email}, 'restored:synthetic-unusable', now())
              on conflict (id) do nothing`;
    }
    for (const a of X.agents) {
      if (M.find((m) => m.agent_id === a.id) == null) throw new Error(`agent ${a.id} not in manifest`);
      await tx`insert into agents (id, owner_id, name, agent_card, status, api_key_hash, is_native, created_at)
              values (${a.id}, ${a.owner_id}, ${a.name}, ${JSON.stringify(a.agent_card)}::jsonb, 'offline', 'restored:synthetic-unusable', false, ${a.created_at})
              on conflict (id) do nothing`;
    }
    for (const m of M) {
      await tx`insert into agent_wallets (agent_id, autonomy_mode) values (${m.agent_id}, 'autonomous') on conflict (agent_id) do nothing`;
      await tx`insert into agent_policy_scope (agent_id) values (${m.agent_id}) on conflict (agent_id) do nothing`;
      const md = m.mandate ?? {};
      await tx`insert into agent_mandates (agent_id, owner_id, objectives, preferences, permissions)
              values (${m.agent_id}, ${m.owner_id}, ${JSON.stringify(md.objectives ?? [])}::jsonb,
                      ${JSON.stringify(md.preferences ?? {})}::jsonb, ${JSON.stringify(md.permissions ?? {})}::jsonb)
              on conflict (agent_id) do nothing`;
    }

    // Conversations the cleanup deleted: is_public iff in frozen public-threads
    // snapshot; created_at = earliest message ts in that thread.
    const convIds = new Set<string>([...X.wave_messages.map((m: any) => m.conversation_id),
      ...X.participants.map((p: any) => p.conversation_id)]);
    const pubConv = new Set<string>(X.public_threads_snapshot.map((c: any) => c.id));
    const earliest: Record<string, string> = {};
    for (const m of X.wave_messages) {
      if (!earliest[m.conversation_id] || m.created_at < earliest[m.conversation_id]) earliest[m.conversation_id] = m.created_at;
    }
    for (const cid of [...convIds].sort()) {
      await tx`insert into conversations (id, is_public, created_at)
              values (${cid}, ${pubConv.has(cid)}, ${earliest[cid] ?? X.exported_at}) on conflict (id) do nothing`;
    }
    for (const p of X.participants) {
      await tx`insert into conversation_participants (conversation_id, agent_id, joined_at)
              values (${p.conversation_id}, ${p.agent_id}, ${p.joined_at}) on conflict do nothing`;
    }
    // Original ids/timestamps/content/reply structure; embeddings are derived
    // data, left null (regenerating them would require model calls — forbidden).
    for (const msg of X.wave_messages) {
      await tx`insert into messages (id, conversation_id, sender_agent_id, content, reply_to_id, created_at)
              values (${msg.id}, ${msg.conversation_id}, ${msg.sender_agent_id}, ${msg.content}, ${msg.reply_to_id}, ${msg.created_at})
              on conflict (id) do nothing`;
    }
    // Schema requires actor fields; these are agent-originated events.
    // Append-only table (no unique key): guard against re-run duplication.
    for (const e of X.security_events) {
      await tx`insert into security_events (actor_type, actor_id, agent_id, event, created_at)
              select 'agent', ${e.agent_id}, ${e.agent_id}, ${e.event}, ${e.created_at}
              where not exists (select 1 from security_events
                where agent_id = ${e.agent_id} and event = ${e.event} and created_at = ${e.created_at})`;
    }
  });
  log("transaction committed");
} catch (e) {
  console.error("RESTORE TRANSACTION FAILED — rolled back:", e);
  await sql.end();
  process.exit(1);
}

// ---- Integrity verification (fail-closed) ----
const checks: [string, boolean][] = [];
const count = async (q: string) => ((await sql.unsafe(q))[0] as any).n as number;

checks.push(["message count == 12", (await count("select count(*)::int n from messages")) === 12]);
const dbMsgs = await sql`select id, conversation_id, sender_agent_id, content, reply_to_id from messages`;
const canon = (m: any) => JSON.stringify({ id: m.id, c: m.conversation_id, s: m.sender_agent_id, t: m.content, r: m.reply_to_id });
const dbSet = new Set<string>(dbMsgs.map(canon));
const exSet = new Set<string>(X.wave_messages.map(canon));
checks.push(["every exported message restored verbatim (id/conv/sender/content/reply)",
  dbSet.size === exSet.size && [...exSet].every((x) => dbSet.has(x))]);
const waveParts = await count(`select count(*)::int n from conversation_participants where agent_id in (${M.map((m) => `'${m.agent_id}'`).join(",")})`);
checks.push(["restored participant rows == 8", waveParts === 8]);
checks.push(["agent count == 13 (10 restored + 3 natives)", (await count("select count(*)::int n from agents")) === 13]);
const natives = await sql`select id from agents where is_native`;
const nativeIds = new Set<string>(natives.map((n: any) => n.id));
const expectedNative = new Set(["5533bf53-dfb1-4d6e-b828-313dd4edb95b", "012630f0-45d5-44d6-a6b7-4c49b7f26525", "74fb6aea-1d5b-4748-8cf0-b52a594048cc"]);
checks.push(["natives untouched (same 3 ids)", nativeIds.size === 3 && [...expectedNative].every((x) => nativeIds.has(x))]);
checks.push(["restored agents non-authenticatable placeholders",
  (await count(`select count(*)::int n from agents where api_key_hash = 'restored:synthetic-unusable'`)) === 10]);
checks.push(["mandates restored == 10", (await count("select count(*)::int n from agent_mandates")) === 10]);
checks.push(["security events == 30", (await count("select count(*)::int n from security_events")) === 30]);
checks.push(["no embeddings regenerated", (await count("select count(*)::int n from messages where embedding is not null")) === 0]);
checks.push(["no presence restored as historical fact",
  (await count("select count(*)::int n from agents where last_seen_at is not null and is_native = false")) === 0]);

let ok = true;
for (const [name, pass] of checks) { log(`  ${pass ? "OK " : "FAIL"} ${name}`); ok = ok && pass; }
log(ok ? "restore verified" : "VERIFICATION FAILED — restore must be discarded");
await sql.end();
await Bun.write("experiments/verse-ecology/analysis/restore-verify.log", out.join("\n") + "\n");
if (!ok) process.exit(1);

