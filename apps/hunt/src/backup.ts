/**
 * Admin backup / restore for the hunt DB (SPEC §2 backups, audit M6).
 *
 * The pair exists because the hunt DB is a single SQLite file on a
 * single Render disk: before this module there was NO agent-reachable
 * channel that could read that disk (Render one-off jobs get ephemeral
 * filesystems — DEPLOY-FIXES-B-REPORT). Both endpoints are admin-only
 * (requireAdmin in app.ts) and are built so no human handles the token:
 * the receiving gateway fetches from the source using its own env copy
 * of HUNT_ADMIN_TOKEN (restore-from), or an operator moves the bytes.
 *
 * Safety design:
 *  - Export is a SQLite online snapshot (VACUUM INTO), never a raw copy
 *    of the live WAL-mode file — the snapshot is transactionally
 *    consistent even while claims are being written.
 *  - Restore validates the staged file BEFORE the live DB is touched
 *    (magic header, size floor, PRAGMA integrity_check, core tables,
 *    schema version), keeps the replaced DB as a timestamped .bak on
 *    the same disk, and swaps by atomic rename.
 *  - Downgrade-to-empty guard: a snapshot whose core tables are all
 *    empty can never overwrite a DB that holds data, unless the caller
 *    passes force — and even then the .bak is kept. This is what makes
 *    it impossible for a fresh auto-created empty DB (the boot hazard:
 *    a gateway on an empty disk silently initialises one) to wipe a
 *    real hunt DB through this path.
 *  - Connection recycle: the live handle sits behind a DbSlot proxy
 *    (db.ts). The swap closes the old connection, renames files, opens
 *    the restored file at the same path, and points the slot at it —
 *    synchronously, so no request can interleave mid-swap, and every
 *    existing consumer (app handlers, ticker, SSE loops) resolves the
 *    new connection on its next call. No handle keeps the old inode.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { openDb, type DbSlot } from "./db";
import { auditInsert, tableCounts, type TableCounts } from "./store";

export type { TableCounts };

/** Upload cap: the disk is 1 GB and a hunt DB is KBs–MBs; the cap keeps
 *  a hostile or mistaken upload from filling the disk. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
/** A real hunt DB carries the full schema — several 4 KiB pages at
 *  minimum. Anything smaller is truncated or not a hunt DB at all. */
export const MIN_SNAPSHOT_BYTES = 8192;

const SQLITE_MAGIC = "SQLite format 3\0";
/** Tables a snapshot must contain to be a hunt DB at all. */
export const CORE_TABLES = [
  "hunt_users",
  "events",
  "prizes",
  "claim_attempts",
  "pool_ledger",
  "audit_log",
] as const;

export interface SnapshotInfo {
  /** Absolute path of the snapshot file (caller streams it, then it is
   *  reaped by the stale-temp cleanup on a later backup call). */
  file: string;
  bytes: number;
  sha256: string;
  counts: TableCounts;
}

export interface RestoreOutcome {
  before: TableCounts;
  after: TableCounts;
  /** Basename of the kept-aside previous DB, e.g. hunt.db.bak-20261110T120000Z */
  bak: string;
  sha256: string;
  forced: boolean;
}

export class RestoreRefusal extends Error {
  status: number;
  code: string;
  detail?: Record<string, unknown>;
  constructor(status: number, code: string, detail?: Record<string, unknown>) {
    super(code);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

/** Directory snapshot temp files live in: beside the DB (same disk, so
 *  the restore rename is atomic); tmpdir for :memory: DBs. */
export function snapshotDirFor(dbPath: string): string {
  return dbPath === ":memory:" ? tmpdir() : dirname(dbPath);
}

/** Sum of the identity/money tables — the downgrade guard's yardstick. */
export function coreTotal(c: TableCounts): number {
  return c.users + c.events + c.prizes + c.claims;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function countsOfFile(file: string): TableCounts {
  const ro = new Database(file, { readonly: true });
  try {
    return tableCounts(ro);
  } finally {
    ro.close();
  }
}

/** Remove snapshot temps older than an hour (a streamed snapshot is
 *  consumed long before that; this bounds disk use if a caller aborts
 *  mid-download). Best-effort — never fails the backup. */
function reapStaleSnapshots(dir: string): void {
  try {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const name of readdirSync(dir)) {
      if (!name.startsWith("hunt-snapshot-")) continue;
      const p = join(dir, name);
      try {
        if (statSync(p).mtimeMs < cutoff) unlinkSync(p);
      } catch {}
    }
  } catch {}
}

/**
 * Transactionally consistent snapshot of the live DB via VACUUM INTO.
 * The snapshot file is left on disk for the caller to stream; counts
 * are read back from the snapshot itself, so what is reported is
 * exactly what was captured.
 */
export function createSnapshot(db: Database, dbPath: string): SnapshotInfo {
  const dir = snapshotDirFor(dbPath);
  reapStaleSnapshots(dir);
  const file = join(dir, `hunt-snapshot-${stamp()}-${Math.random().toString(36).slice(2, 10)}.db`);
  // VACUUM INTO requires the target to not exist; the name is unique.
  db.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  const bytes = readFileSync(file);
  return {
    file,
    bytes: bytes.length,
    sha256: sha256Hex(bytes),
    counts: countsOfFile(file),
  };
}

/**
 * Validate a staged snapshot file WITHOUT touching the live DB.
 * Returns its counts; throws RestoreRefusal on any failure.
 */
export function validateSnapshotFile(file: string, maxSchemaVersion: number): TableCounts {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    throw new RestoreRefusal(400, "invalid_snapshot", { reason: "unreadable" });
  }
  if (size < MIN_SNAPSHOT_BYTES) {
    throw new RestoreRefusal(400, "invalid_snapshot", { reason: "too_small", bytes: size });
  }
  const head = readFileSync(file).subarray(0, 16).toString("latin1");
  if (head !== SQLITE_MAGIC) {
    throw new RestoreRefusal(400, "invalid_snapshot", { reason: "not_sqlite" });
  }
  let ro: Database;
  try {
    ro = new Database(file, { readonly: true });
  } catch {
    throw new RestoreRefusal(400, "invalid_snapshot", { reason: "open_failed" });
  }
  try {
    const ic = ro.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
    if (!ic || ic.integrity_check !== "ok") {
      throw new RestoreRefusal(400, "invalid_snapshot", {
        reason: "integrity_check",
        result: ic?.integrity_check ?? null,
      });
    }
    // Deterministic truncation check: the header's page count must
    // account for every byte in the file (integrity_check alone can
    // pass on a file cut exactly at a page boundary).
    const pc = ro.query("PRAGMA page_count").get() as { page_count: number };
    const ps = ro.query("PRAGMA page_size").get() as { page_size: number };
    if (pc.page_count * ps.page_size !== size) {
      throw new RestoreRefusal(400, "invalid_snapshot", {
        reason: "size_mismatch",
        bytes: size,
        expected: pc.page_count * ps.page_size,
      });
    }
    const tables = new Set(
      (
        ro
          .query("SELECT name FROM sqlite_master WHERE type = 'table'")
          .all() as { name: string }[]
      ).map((r) => r.name),
    );
    const missing = CORE_TABLES.filter((t) => !tables.has(t));
    if (missing.length > 0) {
      throw new RestoreRefusal(400, "invalid_snapshot", { reason: "missing_tables", missing });
    }
    const v = (ro.query("PRAGMA user_version").get() as { user_version: number }).user_version;
    if (v < 1 || v > maxSchemaVersion) {
      throw new RestoreRefusal(400, "invalid_snapshot", { reason: "schema_version", version: v });
    }
    return tableCounts(ro);
  } catch (e) {
    if (e instanceof RestoreRefusal) throw e;
    // A malformed file can make the PRAGMAs themselves throw
    // ("database disk image is malformed") instead of returning a
    // verdict — that is still a validation refusal, not a 500.
    throw new RestoreRefusal(400, "invalid_snapshot", {
      reason: "malformed",
      cause: e instanceof Error ? e.message : String(e),
    });
  } finally {
    ro.close();
  }
}

/** Stage uploaded bytes beside the DB and return the path. The caller
 *  owns cleanup on refusal paths; on success the file is consumed by
 *  the rename into place. */
export function stageSnapshotBytes(dbPath: string, bytes: Uint8Array): string {
  const dir = snapshotDirFor(dbPath);
  const file = join(dir, `hunt-restore-${stamp()}-${Math.random().toString(36).slice(2, 10)}.db`);
  writeFileSync(file, bytes);
  return file;
}

function renameIfExists(from: string, to: string): void {
  if (existsSync(from)) renameSync(from, to);
}

/**
 * Validate + swap a staged snapshot into place behind the slot.
 * Synchronous throughout the swap itself: no request handler or ticker
 * tick can observe a half-moved state. On any refusal the live DB is
 * untouched; on a post-swap verification failure the .bak is rolled
 * back into place and the error surfaces as a 500.
 */
export function restoreSnapshot(
  slot: DbSlot,
  dbPath: string,
  stagedFile: string,
  maxSchemaVersion: number,
  opts: { force?: boolean; now?: number } = {},
): RestoreOutcome {
  if (dbPath === ":memory:") {
    throw new RestoreRefusal(409, "restore_unsupported_memory");
  }
  const stagedCounts = validateSnapshotFile(stagedFile, maxSchemaVersion);
  const before = tableCounts(slot.db);
  const forced = opts.force === true;
  if (coreTotal(before) > 0 && coreTotal(stagedCounts) === 0 && !forced) {
    throw new RestoreRefusal(409, "restore_would_empty", {
      live_counts: before,
      staged_counts: stagedCounts,
    });
  }
  if (!existsSync(stagedFile)) {
    throw new RestoreRefusal(500, "staged_file_missing");
  }
  const sha256 = sha256Hex(readFileSync(stagedFile));
  const bakName = `${dbPath.split("/").pop() ?? "hunt.db"}.bak-${stamp()}`;
  const bakPath = join(dirname(dbPath), bakName);

  const old = slot.current();
  try {
    old.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch {}
  old.close();
  // After a clean close the -wal/-shm sidecars are normally gone; move
  // any stragglers with the main file so the .bak stays whole.
  renameSync(dbPath, bakPath);
  renameIfExists(`${dbPath}-wal`, `${bakPath}-wal`);
  renameIfExists(`${dbPath}-shm`, `${bakPath}-shm`);
  renameSync(stagedFile, dbPath);

  let next: Database;
  try {
    next = openDb(dbPath); // runs any pending migrations forward
    slot.pointTo(next);
    const ic = next.query("PRAGMA integrity_check").get() as { integrity_check: string } | null;
    if (!ic || ic.integrity_check !== "ok") throw new Error("post-restore integrity_check failed");
  } catch (e) {
    // Roll back: drop the bad file, put the .bak back, reopen, repoint.
    try {
      slot.current().close();
    } catch {}
    try {
      unlinkSync(dbPath);
    } catch {}
    renameIfExists(`${bakPath}-wal`, `${dbPath}-wal`);
    renameIfExists(`${bakPath}-shm`, `${dbPath}-shm`);
    renameSync(bakPath, dbPath);
    slot.pointTo(openDb(dbPath));
    throw new RestoreRefusal(500, "restore_failed_rolled_back", {
      cause: e instanceof Error ? e.message : String(e),
    });
  }

  const after = tableCounts(slot.db);
  auditInsert(slot.db, "admin", "db_restore", bakName, {
    before,
    after,
    sha256,
    forced,
  }, opts.now ?? Date.now());
  return { before, after, bak: bakName, sha256, forced };
}
