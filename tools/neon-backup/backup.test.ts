import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  artifactName,
  isoWeekKey,
  parseBackupKey,
  pgEnvFromUrl,
  planRetention,
  sigv4Authorization,
} from "./backup";

const key = (iso: string) =>
  `backups/neon/neon-backup-${iso.replace(/[-:]/g, "")}.dump`;
// iso like "2026-10-05T08:00:00Z" -> neon-backup-20261005T080000Z.dump

describe("sigv4Authorization", () => {
  test("matches the AWS documentation test vector byte-for-byte", () => {
    // AWS SigV4 docs example: GET iam ListUsers, 2015-08-30T12:36:00Z,
    // AKIDEXAMPLE / wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY.
    const { authorization } = sigv4Authorization({
      method: "GET",
      host: "iam.amazonaws.com",
      path: "/",
      query: "Action=ListUsers&Version=2010-05-08",
      headers: {
        "content-type": "application/x-www-form-urlencoded; charset=utf-8",
      },
      payloadHash: createHash("sha256").update("").digest("hex"),
      accessKeyId: "AKIDEXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
      region: "us-east-1",
      service: "iam",
      date: new Date("2015-08-30T12:36:00Z"),
    });
    expect(authorization).toContain(
      "Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7",
    );
  });
});

describe("parseBackupKey / artifactName", () => {
  test("round-trips", () => {
    const name = artifactName(new Date("2026-11-10T08:00:05Z"));
    expect(name).toBe("neon-backup-20261110T080005Z.dump");
    expect(parseBackupKey(`backups/neon/${name}`)?.toISOString()).toBe(
      "2026-11-10T08:00:05.000Z",
    );
  });
  test("rejects foreign keys", () => {
    expect(parseBackupKey("backups/neon/readme.txt")).toBeNull();
    expect(parseBackupKey("backups/neon/neon-backup-2026.dump")).toBeNull();
  });
});

describe("isoWeekKey", () => {
  test("known dates", () => {
    expect(isoWeekKey(new Date("2026-11-10T08:00:00Z"))).toBe("2026-W46");
    expect(isoWeekKey(new Date("2026-01-01T00:00:00Z"))).toBe("2026-W01");
    expect(isoWeekKey(new Date("2025-12-29T00:00:00Z"))).toBe("2026-W01");
  });
});

describe("planRetention", () => {
  // Two backups a day (08:00 and 20:00) for 30 consecutive days,
  // 2026-10-12 .. 2026-11-10.
  const keys: string[] = [];
  for (let d = 0; d < 30; d++) {
    const day = new Date(Date.UTC(2026, 9, 12 + d));
    for (const hh of ["08", "20"]) {
      const iso = `${day.toISOString().slice(0, 10)}T${hh}:00:00Z`;
      keys.push(key(iso));
    }
  }
  test("keeps 7 dailies + weekly anchors, deletes the rest", () => {
    const plan = planRetention(keys, 7, 4);
    expect(plan.keep).toContain(key("2026-11-10T20:00:00Z")); // newest overall
    // 7 most recent days present, latest of each:
    for (const day of ["04", "05", "06", "07", "08", "09", "10"]) {
      expect(plan.keep).toContain(key(`2026-11-${day}T20:00:00Z`));
    }
    // Morning backups of kept days are NOT kept (only the day's latest).
    expect(plan.delete).toContain(key("2026-11-10T08:00:00Z"));
    // Weekly anchors reach back beyond the daily window.
    expect(plan.keep.length).toBeGreaterThan(7);
    expect(plan.keep.length).toBeLessThanOrEqual(11);
    expect(plan.keep.length + plan.delete.length).toBe(keys.length);
    expect(plan.unknown).toEqual([]);
  });

  test("idempotent: planning over the kept set deletes nothing", () => {
    const plan = planRetention(keys, 7, 4);
    const again = planRetention(plan.keep, 7, 4);
    expect(again.delete).toEqual([]);
    expect(again.keep.sort()).toEqual([...plan.keep].sort());
  });

  test("gap-tolerant: a sparse history keeps everything it has", () => {
    const sparse = [
      key("2026-11-10T08:00:00Z"),
      key("2026-11-02T08:00:00Z"),
      key("2026-09-01T08:00:00Z"),
    ];
    const plan = planRetention(sparse, 7, 4);
    expect(plan.delete).toEqual([]);
  });

  test("unknown keys are never deleted", () => {
    const plan = planRetention(
      [...keys, "backups/neon/manual-snapshot.dump", "backups/neon/notes.txt"],
      7,
      4,
    );
    expect(plan.unknown).toEqual([
      "backups/neon/manual-snapshot.dump",
      "backups/neon/notes.txt",
    ]);
    expect(plan.delete).not.toContain("backups/neon/manual-snapshot.dump");
  });

  test("empty bucket is a no-op", () => {
    expect(planRetention([])).toEqual({ keep: [], delete: [], unknown: [] });
  });
});

describe("pgEnvFromUrl", () => {
  test("decomposes without leaking the string anywhere", () => {
    const env = pgEnvFromUrl(
      "postgres://user:p%40ss@ep-example.us-east-1.aws.neon.tech/neondb?sslmode=require",
    );
    expect(env).toEqual({
      PGHOST: "ep-example.us-east-1.aws.neon.tech",
      PGPORT: "5432",
      PGUSER: "user",
      PGPASSWORD: "p@ss",
      PGDATABASE: "neondb",
      PGSSLMODE: "require",
    });
  });
  test("defaults sslmode to require", () => {
    expect(pgEnvFromUrl("postgres://u@h:5433/db").PGSSLMODE).toBe("require");
    expect(pgEnvFromUrl("postgres://u@h:5433/db").PGPORT).toBe("5433");
  });
});
