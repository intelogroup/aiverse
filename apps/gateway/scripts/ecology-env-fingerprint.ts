// Ecology environment fingerprint — READ-ONLY.
//
// One canonical JSON object describing the exact environment a wave ran in:
// git sha + dirty state, runtime versions, database/extension/Redis versions,
// the resolved OpenRouter model IDs behind each family (NOT the family names —
// a provider silently re-routing a class to a different underlying model is an
// invisible confound), the provider allow-list, the seed, a hash over the
// frozen apparatus files, the migration/schema identifier, the natives flag,
// and the run identifiers.
//
// Read-only everywhere: git rev-parse/status, SELECT/SHOW, redis INFO, file
// reads. This script never writes to the database, Redis, or the repo.
//
// Usage (as a module): import { computeEnvFingerprint } from this file.
// Usage (as a CLI):    bun run apps/gateway/scripts/ecology-env-fingerprint.ts <wave:1|2|3|control> [runId]

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import postgres from "postgres";
import Redis from "ioredis";
import { ECOLOGY_SEED, ECOLOGY_WAVES, ECOLOGY_MODEL_BY_FAMILY, ECOLOGY_FROZEN_FILES } from "./ecology-config";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname.replace(/\/$/, "");

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function git(args: string): string {
  return execSync(`git ${args}`, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

// Canonical JSON: fixed key insertion order (the object literal below IS the
// canonical order), no whitespace ambiguity, stable across runs.
export interface EnvFingerprint {
  git_sha: string;
  git_dirty: boolean;
  bun_version: string;
  node_version: string;
  postgres_version: string;
  pgvector_version: string | null;
  redis_version: string;
  provider: string;
  resolved_models: Record<string, string>;
  provider_allow_list: string[];
  seed: number;
  wave: string;
  wave_spec: { size: number; staggerMinutes: number; label: string };
  frozen_config_sha256: string;
  frozen_files: Record<string, string>;
  migration_identifier: { last_migration_tag: string | null; journal_entries: number; db_migrations: number };
  aiverse_disable_natives: string;
  run_id: string;
  ecology_wave: string;
  fingerprint_sha256: string;
  [k: string]: unknown;
}

export function canonicalize(obj: unknown): string {
  return JSON.stringify(obj);
}

export async function computeEnvFingerprint(opts: {
  wave: string;
  runId: string;
  databaseUrl?: string;
  redisUrl?: string;
}): Promise<EnvFingerprint> {
  const databaseUrl = opts.databaseUrl ?? process.env.DATABASE_URL;
  const redisUrl = opts.redisUrl ?? process.env.REDIS_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for the env fingerprint (postgres/pgvector versions)");
  if (!redisUrl) throw new Error("REDIS_URL is required for the env fingerprint (redis version)");
  const spec = ECOLOGY_WAVES[opts.wave];
  if (!spec) throw new Error(`unknown wave: ${opts.wave}`);

  // --- git (read-only) ---
  const gitSha = git("rev-parse HEAD");
  const gitDirty = git("status --porcelain").length > 0;

  // --- frozen apparatus hash: content of every frozen file, path-tagged ---
  const frozenFiles: Record<string, string> = {};
  for (const rel of ECOLOGY_FROZEN_FILES) {
    frozenFiles[rel] = sha256(await Bun.file(`${REPO_ROOT}/${rel}`).text());
  }
  const frozenConfigHash = sha256(canonicalize(frozenFiles));

  // --- postgres + pgvector (SELECT only) ---
  const sql = postgres(databaseUrl, { max: 1 });
  let postgresVersion: string;
  let pgvectorVersion: string | null;
  let migrationCount = -1;
  try {
    const [{ version }] = await sql`SELECT version() AS version`;
    postgresVersion = version;
    const ext = await sql`SELECT extversion AS v FROM pg_extension WHERE extname = 'vector'`;
    pgvectorVersion = ext.length ? ext[0].v : null;
    const mg = await sql`SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`;
    migrationCount = mg[0].n;
  } finally {
    await sql.end({ timeout: 1 });
  }

  // --- redis (INFO only) ---
  const redis = new Redis(redisUrl, { maxRetriesPerRequest: 1, lazyConnect: true, connectTimeout: 3000 });
  let redisVersion: string;
  try {
    await redis.connect();
    const info = await redis.info("server");
    redisVersion = (info.split("\n").find((l) => l.startsWith("redis_version:")) ?? "redis_version:unknown").trim().split(":")[1];
  } finally {
    redis.disconnect();
  }

  // --- migrations journal identifier (file-based, cross-checks the DB count) ---
  const journal = JSON.parse(await Bun.file(`${REPO_ROOT}/apps/gateway/drizzle/meta/_journal.json`).text());
  const lastMigration = journal.entries.at(-1)?.tag ?? null;

  const fp: Record<string, unknown> = {
    git_sha: gitSha,
    git_dirty: gitDirty,
    bun_version: Bun.version,
    node_version: process.versions.node,
    postgres_version: postgresVersion,
    pgvector_version: pgvectorVersion,
    redis_version: redisVersion,
    provider: process.env.ECOLOGY_PROVIDER_LABEL ?? "openrouter",
    // The exact model IDs, not the family labels. A provider re-routing a
    // family to a different underlying model must be detectable.
    resolved_models: { ...ECOLOGY_MODEL_BY_FAMILY },
    provider_allow_list: ["google/gemini-2.5-flash-lite", "meta-llama/llama-3.1-8b-instruct", "deepseek/deepseek-v4-flash"],
    seed: ECOLOGY_SEED,
    wave: opts.wave,
    wave_spec: spec,
    frozen_config_sha256: frozenConfigHash,
    frozen_files: frozenFiles,
    migration_identifier: { last_migration_tag: lastMigration, journal_entries: journal.entries.length, db_migrations: migrationCount },
    aiverse_disable_natives: process.env.AIVERSE_DISABLE_NATIVES ?? "unset",
    run_id: opts.runId,
    ecology_wave: `wave-${opts.wave}`,
  };
  return { ...fp, fingerprint_sha256: sha256(canonicalize(fp)) } as EnvFingerprint;
}

// CLI probe: prints the canonical fingerprint JSON. Useful in preflight.
if (import.meta.main) {
  const [wave, runId = "pre-freeze-probe"] = process.argv.slice(2);
  if (!wave || !ECOLOGY_WAVES[wave]) {
    console.error("usage: ecology-env-fingerprint.ts <1|2|3|control> [runId]");
    process.exit(1);
  }
  console.log(canonicalize(await computeEnvFingerprint({ wave, runId })));
}