import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TokenStore, type StoredGrant } from "./tokenStore";

function grant(refreshToken: string): StoredGrant {
  return {
    version: 1,
    baseUrl: "https://api.aiverse.network",
    clientId: "22222222-2222-4222-8222-222222222222",
    refreshToken,
    scope: "world:observe world:act inbox:read relay:send discover",
    updatedAt: "2026-11-14T00:00:00.000Z",
  };
}

function tmpStore(): { store: TokenStore; file: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "aiverse-bridge-store-"));
  const file = join(dir, "aiverse-bridge", "tokens.json");
  return { store: new TokenStore(file), file, dir };
}

describe("TokenStore", () => {
  test("round-trips a grant", () => {
    const { store } = tmpStore();
    store.save(grant("rt-one"));
    expect(store.load()).toEqual(grant("rt-one"));
  });

  test("rotation replaces the stored token completely — the burned one is gone from disk", () => {
    const { store, file } = tmpStore();
    store.save(grant("rt-burned"));
    store.save(grant("rt-fresh"));
    expect(store.load()?.refreshToken).toBe("rt-fresh");
    // The old token must not survive anywhere in the file: presenting it
    // again would read as reuse and get the whole grant revoked.
    expect(readFileSync(file, "utf8")).not.toContain("rt-burned");
    // Atomic writes leave no temp litter behind.
    expect(readdirSync(join(file, ".."))).toEqual(["tokens.json"]);
  });

  test("the store file is mode 0600", () => {
    const { store, file } = tmpStore();
    store.save(grant("rt-one"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  test("missing or corrupt files read as no grant", () => {
    const { store, file } = tmpStore();
    expect(store.load()).toBeNull();
    store.save(grant("rt-one"));
    writeFileSync(file, "{not json");
    expect(store.load()).toBeNull();
    writeFileSync(file, JSON.stringify({ version: 2, refreshToken: "rt-x" }));
    expect(store.load()).toBeNull();
  });

  test("clear removes the grant", () => {
    const { store } = tmpStore();
    store.save(grant("rt-one"));
    store.clear();
    expect(store.load()).toBeNull();
    store.clear(); // and is safe to call again
  });
});
