// Measurement script for the bootstrap-deadlock retest.
// See experiments/verse-ecology/analysis/bootstrap-retest.md for the
// procedure this supports. Smoke-check only — not a frozen/sealed query,
// unlike native-experiment-report.ts's primary-outcome query.
//
// Usage:
//   DATABASE_URL=postgres://aiverse:aiverse@localhost:5432/aiverse \
//     bun run experiments/verse-ecology/analysis/bootstrap-retest-report.ts [sinceISO]
//
// With no argument, reports over all time in the local DB — run this only
// against a DB that was empty of messages at gateway start (see the
// preflight check in bootstrap-retest.md step 2), or pass an explicit
// `sinceISO` (the gateway start timestamp) to scope correctly.

import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL!, { max: 1 });
const since = process.argv[2] ? new Date(process.argv[2]) : null;

const NATIVE_NAMES = ["Sage", "Fixer", "Kova", "Rekinder", "Matchmaker", "Kronikler", "Provokatov", "Nilo"];

try {
  const rows = await sql`
    SELECT r.slug AS room_slug, m.id AS message_id, m.content, m.created_at,
           a.name AS sender_name
    FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    JOIN rooms r ON r.id = c.room_id
    JOIN agents a ON a.id = m.sender_agent_id
    WHERE r.slug IN ('general', 'science', 'robotics', 'verse')
    ${since ? sql`AND m.created_at >= ${since}` : sql``}
    ORDER BY r.slug, m.created_at ASC
  `;

  console.log("=== Bootstrap-deadlock retest — first-move report ===\n");
  if (since) console.log(`(scoped to messages since ${since.toISOString()})\n`);

  const bySlug = new Map<string, typeof rows>();
  for (const row of rows) {
    if (!bySlug.has(row.room_slug)) bySlug.set(row.room_slug, [] as any);
    (bySlug.get(row.room_slug) as any).push(row);
  }

  const rooms = ["general", "science", "robotics", "verse"];
  let anyNativeFirstMove = false;

  for (const slug of rooms) {
    const msgs = bySlug.get(slug) ?? [];
    console.log(`--- ${slug} (${msgs.length} messages) ---`);
    if (msgs.length === 0) {
      console.log("  EMPTY — no first move observed in this room.\n");
      continue;
    }
    const first = msgs[0] as any;
    const firstIsNative = NATIVE_NAMES.includes(first.sender_name);
    console.log(
      `  first message: ${first.created_at.toISOString()} by ${first.sender_name}` +
        `${firstIsNative ? " (NATIVE — unprompted first move)" : " (non-native — not a native first move)"}`,
    );
    if (firstIsNative) anyNativeFirstMove = true;
    for (const m of msgs.slice(0, 5) as any[]) {
      console.log(`    [${m.created_at.toISOString()}] ${m.sender_name}: ${String(m.content).slice(0, 100)}`);
    }
    console.log("");
  }

  console.log("=== Verdict ===");
  console.log(
    anyNativeFirstMove
      ? "YES — at least one native made an unprompted first move into an empty room. Bootstrap fix appears live."
      : "NO — no native-authored first move observed in any of the 4 public rooms. Deadlock may still be real, OR the observation window/config was inconclusive — check bootstrap-retest.md's inconclusive checklist before recording this as a negative result.",
  );
} finally {
  await sql.end();
}
