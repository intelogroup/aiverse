#!/usr/bin/env bun
/**
 * Migration journal consistency gate.
 *
 * Drizzle's migrator applies ONLY what meta/_journal.json lists — a SQL file
 * that exists on disk but has no journal entry is silently never applied, on
 * any environment, with every other gate green. That exact failure shipped
 * once: 0032_nice_hercules.sql (the agent_wallets.autonomy_mode default)
 * sat unjournaled next to a *different* journaled 0032 file, and nothing
 * noticed. This script is the gate that would have caught it.
 *
 * Checks (any violation -> exit 1, all violations printed):
 *   1. Every journal entry's tag has a matching `<tag>.sql` file on disk.
 *   2. Every `*.sql` file on disk has exactly one journal entry with its tag.
 *   3. Numeric filename prefixes are unique across files (no two `0032_*`).
 *   4. Journal idx values are exactly 0..n-1, in order, and their numeric
 *      prefixes strictly increase along the journal (append-only history).
 *
 * Usage: bun run apps/gateway/scripts/check-migration-journal.ts [drizzleDir]
 * Default drizzleDir: ../drizzle relative to this script (apps/gateway/drizzle).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const drizzleDir = resolve(process.argv[2] ?? join(scriptDir, "..", "drizzle"));
const journalPath = join(drizzleDir, "meta", "_journal.json");

const problems: string[] = [];

if (!existsSync(journalPath)) {
  console.error(`check-migration-journal: no journal at ${journalPath}`);
  process.exit(1);
}

type JournalEntry = { idx: number; tag: string; when: number };
const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
  entries: JournalEntry[];
};
const entries = journal.entries ?? [];

const files = readdirSync(drizzleDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();
const fileTags = files.map((f) => f.slice(0, -".sql".length));
const fileTagSet = new Set(fileTags);
const journalTags = entries.map((e) => e.tag);
const journalTagSet = new Set(journalTags);

// 1. Journal entries must point at real files.
for (const tag of journalTags) {
  if (!fileTagSet.has(tag)) {
    problems.push(`journal entry "${tag}" has no ${tag}.sql file on disk`);
  }
}

// 2. Every file must be journaled exactly once.
const tagCounts = new Map<string, number>();
for (const t of journalTags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
for (const tag of fileTags) {
  const n = tagCounts.get(tag) ?? 0;
  if (n === 0) {
    problems.push(
      `migration file ${tag}.sql is NOT in the journal — drizzle will never apply it`,
    );
  } else if (n > 1) {
    problems.push(`migration file ${tag}.sql has ${n} journal entries`);
  }
}

// 3. Numeric prefixes unique across files.
const prefixOf = (tag: string) => {
  const m = /^(\d+)_/.exec(tag);
  return m ? m[1] : null;
};
const prefixCounts = new Map<string, string[]>();
for (const tag of fileTags) {
  const p = prefixOf(tag);
  if (p === null) {
    problems.push(`migration file ${tag}.sql does not start with a numeric prefix`);
    continue;
  }
  prefixCounts.set(p, [...(prefixCounts.get(p) ?? []), tag]);
}
for (const [p, tags] of prefixCounts) {
  if (tags.length > 1) {
    problems.push(
      `numeric prefix ${p} is shared by ${tags.length} files: ${tags.join(", ")}`,
    );
  }
}

// 4. Journal idx sequence is 0..n-1 in order; prefixes strictly increase.
let lastPrefix = -1;
entries.forEach((e, i) => {
  if (e.idx !== i) {
    problems.push(`journal entry ${i} ("${e.tag}") has idx ${e.idx}, expected ${i}`);
  }
  const p = prefixOf(e.tag);
  if (p !== null) {
    const n = parseInt(p, 10);
    if (n <= lastPrefix) {
      problems.push(
        `journal prefix order breaks at "${e.tag}" (${p} after ${String(lastPrefix).padStart(4, "0")})`,
      );
    }
    lastPrefix = n;
  }
});

if (problems.length > 0) {
  console.error(
    `check-migration-journal: ${problems.length} problem(s) in ${drizzleDir}:`,
  );
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `check-migration-journal: OK — ${files.length} migration files, ${entries.length} journal entries, consistent`,
);
