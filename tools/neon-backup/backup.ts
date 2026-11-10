#!/usr/bin/env bun
/**
 * neon-backup — daily pg_dump of the production Neon database to R2.
 *
 * Runs as a Render cron job (see NEON-BACKUP-JOB-REPORT.md). One run:
 *   1. pg_dump -Fc of DATABASE_URL_DIRECT (the direct string — the pooled
 *      URL is wrong for a dump) into a temp file. The connection string is
 *      decomposed into PG* environment variables; it never appears in a
 *      child process's argv or in any log line.
 *   2. Self-check: pg_restore --list must succeed on the produced file,
 *      or the run fails and nothing is uploaded.
 *   3. Upload to s3://$R2_BUCKET/$BACKUP_PREFIX/neon-backup-<UTC ts>.dump
 *      (SigV4, path-style — R2's S3 endpoint), then HEAD-verify the size.
 *   4. Retention prune (idempotent): keep the newest backup of each of the
 *      7 most recent backup-days present, plus the newest backup of each
 *      of the 4 most recent backup-weeks (ISO) present; delete the rest.
 *      Keys that do not parse as backup names are never deleted.
 *
 * Env: DATABASE_URL_DIRECT (required)
 *      R2_ENDPOINT, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY (required
 *      unless --dry-run), R2_BUCKET (default "verse-assets"),
 *      BACKUP_PREFIX (default "backups/neon")
 * Flags: --dry-run   dump + self-check only; no upload, no prune
 *        --prune-only  retention pass only; no dump
 * Exit: 0 on success, 1 on any failure (Render cron surfaces failed runs).
 */
import { createHash, createHmac } from "node:crypto";
import { readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

// ---------------------------------------------------------------- retention

export interface BackupEntry {
  key: string;
  ts: Date;
}

const NAME_RE = /^neon-backup-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z\.dump$/;

export function parseBackupKey(key: string): Date | null {
  const base = key.split("/").pop() ?? "";
  const m = NAME_RE.exec(base);
  if (!m) return null;
  const [, y, mo, d, h, mi, s] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10); // UTC YYYY-MM-DD
}

/** ISO-8601 week key, e.g. "2026-W46". */
export function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  date.setUTCDate(date.getUTCDate() - dayNum + 3); // Thursday of this week
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const fDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fDayNum + 3);
  const week = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 86400_000));
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

export interface RetentionPlan {
  keep: string[];
  delete: string[];
  unknown: string[]; // keys under the prefix that are not backup names
}

/**
 * Pure retention planner — a function of the key list only (plus limits),
 * so re-running it on its own output deletes nothing further (idempotent).
 * Data-driven (most recent days/weeks *present*), so gaps in the schedule
 * shrink the window instead of deleting across the gap.
 */
export function planRetention(
  keys: string[],
  daily = 7,
  weekly = 4,
): RetentionPlan {
  const entries: BackupEntry[] = [];
  const unknown: string[] = [];
  for (const key of keys) {
    const ts = parseBackupKey(key);
    if (ts) entries.push({ key, ts });
    else unknown.push(key);
  }
  entries.sort((a, b) => b.ts.getTime() - a.ts.getTime()); // newest first
  const keep = new Set<string>();

  const latestOfGroup = (groupOf: (d: Date) => string, limit: number) => {
    const groups = new Map<string, BackupEntry>(); // group -> newest entry
    for (const e of entries) {
      const g = groupOf(e.ts);
      if (!groups.has(g)) groups.set(g, e);
    }
    [...groups.keys()]
      .sort()
      .reverse()
      .slice(0, limit)
      .forEach((g) => keep.add(groups.get(g)!.key));
  };
  latestOfGroup(dayKey, daily);
  latestOfGroup(isoWeekKey, weekly);
  if (entries.length) keep.add(entries[0].key); // newest overall, always

  return {
    keep: entries.filter((e) => keep.has(e.key)).map((e) => e.key),
    delete: entries.filter((e) => !keep.has(e.key)).map((e) => e.key),
    unknown,
  };
}

// --------------------------------------------------------------------- sigv4

export interface SignInput {
  method: string;
  host: string; // e.g. "<acct>.r2.cloudflarestorage.com"
  path: string; // already URI-encoded, leading "/"
  query: string; // raw query string without "?", "" if none
  headers: Record<string, string>; // extra signed headers (lowercase keys)
  payloadHash: string; // hex sha256 of the body ("" body -> hash of empty)
  accessKeyId: string;
  secretAccessKey: string;
  region: string; // R2: "auto"
  service: string; // "s3"
  date: Date;
}

export function sigv4Authorization(input: SignInput): {
  authorization: string;
  amzDate: string;
} {
  const amzDate = input.date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const signedHeadersMap: Record<string, string> = {
    host: input.host,
    "x-amz-date": amzDate,
    ...input.headers,
  };
  const signedHeaderNames = Object.keys(signedHeadersMap).sort();
  const canonicalHeaders = signedHeaderNames
    .map((n) => `${n}:${signedHeadersMap[n].trim()}\n`)
    .join("");
  const canonicalRequest = [
    input.method,
    input.path,
    input.query,
    canonicalHeaders,
    signedHeaderNames.join(";"),
    input.payloadHash,
  ].join("\n");
  const scope = `${dateStamp}/${input.region}/${input.service}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    createHash("sha256").update(canonicalRequest).digest("hex"),
  ].join("\n");
  const hmac = (key: Buffer | string, data: string) =>
    createHmac("sha256", key).update(data).digest();
  const kDate = hmac(`AWS4${input.secretAccessKey}`, dateStamp);
  const kRegion = hmac(kDate, input.region);
  const kService = hmac(kRegion, input.service);
  const kSigning = hmac(kService, "aws4_request");
  const signature = createHmac("sha256", kSigning)
    .update(stringToSign)
    .digest("hex");
  return {
    authorization:
      `AWS4-HMAC-SHA256 Credential=${input.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaderNames.join(";")}, Signature=${signature}`,
    amzDate,
  };
}

// ------------------------------------------------------------------- s3 (R2)

class R2 {
  constructor(
    private endpoint: string, // no trailing slash
    private bucket: string,
    private keyId: string,
    private secret: string,
  ) {}

  private async request(
    method: string,
    key: string | null, // null -> bucket-level (list)
    query: Record<string, string>,
    body?: Buffer,
  ): Promise<Response> {
    const url = new URL(this.endpoint);
    const path =
      key === null
        ? `/${this.bucket}`
        : `/${this.bucket}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const qs = new URLSearchParams(query).toString();
    const payloadHash = createHash("sha256")
      .update(body ?? Buffer.alloc(0))
      .digest("hex");
    const { authorization, amzDate } = sigv4Authorization({
      method,
      host: url.host,
      path,
      query: qs,
      headers: { "x-amz-content-sha256": payloadHash },
      payloadHash,
      accessKeyId: this.keyId,
      secretAccessKey: this.secret,
      region: "auto",
      service: "s3",
      date: new Date(),
    });
    return fetch(`${this.endpoint}${path}${qs ? `?${qs}` : ""}`, {
      method,
      headers: {
        Authorization: authorization,
        "x-amz-date": amzDate,
        "x-amz-content-sha256": payloadHash,
        ...(body ? { "Content-Length": String(body.length) } : {}),
      },
      body: body ? new Uint8Array(body) : undefined,
    });
  }

  async put(key: string, body: Buffer, sha256: string): Promise<void> {
    const res = await this.request("PUT", key, {}, body);
    if (!res.ok)
      throw new Error(`R2 PUT ${key} -> HTTP ${res.status}: ${await res.text()}`);
  }

  async headSize(key: string): Promise<number> {
    const res = await this.request("HEAD", key, {});
    if (!res.ok) throw new Error(`R2 HEAD ${key} -> HTTP ${res.status}`);
    return Number(res.headers.get("content-length") ?? -1);
  }

  async list(prefix: string): Promise<string[]> {
    const keys: string[] = [];
    let token: string | undefined;
    for (;;) {
      const q: Record<string, string> = { "list-type": "2", prefix };
      if (token) q["continuation-token"] = token;
      const res = await this.request("GET", null, q);
      if (!res.ok)
        throw new Error(`R2 LIST -> HTTP ${res.status}: ${await res.text()}`);
      const xml = await res.text();
      for (const m of xml.matchAll(/<Key>([^<]+)<\/Key>/g))
        keys.push(
          m[1]
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">"),
        );
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const next = /<NextContinuationToken>([^<]+)<\/NextContinuationToken>/.exec(xml);
      if (!truncated || !next) break;
      token = next[1];
    }
    return keys;
  }

  async delete(key: string): Promise<void> {
    const res = await this.request("DELETE", key, {});
    if (!res.ok && res.status !== 404)
      throw new Error(`R2 DELETE ${key} -> HTTP ${res.status}`);
  }
}

// -------------------------------------------------------------------- helpers

function run(
  cmd: string,
  args: string[],
  env: Record<string, string>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`${cmd} exited ${code}: ${stderr.slice(-400)}`)),
    );
  });
}

/** Decompose a postgres:// URL into PG* env vars (never logged, never argv). */
export function pgEnvFromUrl(raw: string): Record<string, string> {
  const u = new URL(raw);
  const env: Record<string, string> = {
    PGHOST: u.hostname,
    PGPORT: u.port || "5432",
    PGUSER: decodeURIComponent(u.username),
    PGDATABASE: decodeURIComponent(u.pathname.replace(/^\//, "")),
    PGSSLMODE: u.searchParams.get("sslmode") ?? "require",
  };
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  return env;
}

export function artifactName(now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `neon-backup-${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}` +
    `T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z.dump`
  );
}

function env(name: string, required = true): string {
  const v = process.env[name];
  if (required && !v) throw new Error(`missing env ${name}`);
  return v ?? "";
}

// ----------------------------------------------------------------------- main

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const dryRun = args.has("--dry-run");
  const pruneOnly = args.has("--prune-only");
  const bucket = process.env.R2_BUCKET || "verse-assets";
  const prefix = (process.env.BACKUP_PREFIX || "backups/neon").replace(/\/$/, "");

  const r2 = dryRun
    ? null
    : new R2(
        env("R2_ENDPOINT").replace(/\/$/, ""),
        bucket,
        env("R2_ACCESS_KEY_ID"),
        env("R2_SECRET_ACCESS_KEY"),
      );

  if (!pruneOnly) {
    const pgEnv = pgEnvFromUrl(env("DATABASE_URL_DIRECT"));
    const name = artifactName();
    const file = join(tmpdir(), name);
    try {
      await run("pg_dump", ["-Fc", "--no-owner", "-f", file], pgEnv);
      // A backup that cannot even be listed is not shipped.
      await run("pg_restore", ["--list", file], {});
      const size = (await stat(file)).size;
      const sha256 = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
      if (dryRun || !r2) {
        console.log(
          JSON.stringify({
            event: "neon_backup_dry_run",
            artifact: name,
            bytes: size,
            sha256: sha256.slice(0, 16),
          }),
        );
        return;
      }
      const key = `${prefix}/${name}`;
      await r2.put(key, await readFile(file), sha256);
      const remoteSize = await r2.headSize(key);
      if (remoteSize !== size)
        throw new Error(`size mismatch after upload: local ${size}, remote ${remoteSize}`);
      console.log(
        JSON.stringify({
          event: "neon_backup_uploaded",
          artifact: key,
          bytes: size,
          sha256: sha256.slice(0, 16),
        }),
      );
    } finally {
      await rm(file, { force: true });
    }
  }

  if (r2) {
    const keys = await r2.list(`${prefix}/`);
    const plan = planRetention(keys);
    for (const key of plan.delete) await r2.delete(key);
    console.log(
      JSON.stringify({
        event: "neon_backup_retention",
        kept: plan.keep.length,
        deleted: plan.delete.length,
        unknownKeysSkipped: plan.unknown.length,
      }),
    );
  }
  console.log(JSON.stringify({ event: "neon_backup_ok" }));
}

if (import.meta.main) {
  main().catch((e) => {
    console.error(`neon_backup_failed: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  });
}
