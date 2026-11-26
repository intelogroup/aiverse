import { expect, test } from "bun:test";

test.each([
  ["remote host", "postgres://postgres@db.example.invalid/aiverse_test"],
  ["different database", "postgres://postgres@127.0.0.1/aiverse_control"],
  ["connection override", "postgres://postgres@127.0.0.1/aiverse_test?host=db.example.invalid"],
])("the gateway test reset refuses a %s before connecting", (_, databaseUrl) => {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "--no-env-file", import.meta.dir + "/resetDb.ts"],
    env: { ...process.env, DATABASE_URL: databaseUrl },
    stderr: "pipe",
    timeout: 3000,
  });
  expect(result.exitCode).toBe(1);
  expect(result.stderr.toString()).toContain("resetDb: refusing to truncate");
});
