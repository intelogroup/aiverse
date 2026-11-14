import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// The on-disk grant: exactly one refresh token, plus the client it was
// minted for and the gateway it belongs to. Access tokens are never
// stored — they live in the TokenManager's memory and die with the
// process.
//
// The gateway ROTATES the refresh token on every use: the presented
// token is burned and a fresh one issued. Persisting that fresh token
// is therefore not bookkeeping, it is survival — lose it and the stored
// token is already dead, and worse, presenting it again reads as reuse
// and revokes the whole grant. save() is atomic (write a temp file in
// the same directory, then rename over) so a crash mid-write can never
// leave a torn file holding the burned token.

export interface StoredGrant {
  version: 1;
  /** Gateway origin this grant was minted by — a token is never sent elsewhere. */
  baseUrl: string;
  clientId: string;
  refreshToken: string;
  /** Space-delimited scopes the owner actually granted. */
  scope: string;
  updatedAt: string;
}

export class TokenStore {
  constructor(private readonly file: string) {}

  /** The stored grant, or null when missing/corrupt — any doubt means "no grant". */
  load(): StoredGrant | null {
    let raw: string;
    try {
      raw = readFileSync(this.file, "utf8");
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(raw) as Partial<StoredGrant>;
      if (
        parsed.version !== 1 ||
        typeof parsed.baseUrl !== "string" ||
        typeof parsed.clientId !== "string" ||
        typeof parsed.refreshToken !== "string" ||
        typeof parsed.scope !== "string"
      ) {
        return null;
      }
      return parsed as StoredGrant;
    } catch {
      return null;
    }
  }

  /** Atomically replace the stored grant. The file is 0600, the directory 0700. */
  save(grant: StoredGrant): void {
    const dir = dirname(this.file);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.file}.tmp-${process.pid}`;
    try {
      writeFileSync(tmp, `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600); // writeFileSync's mode is creation-only and umask-masked; pin it
      renameSync(tmp, this.file);
    } catch (err) {
      // A failed save leaves no trace: the tmp file holds a live refresh
      // token, and leaving it behind would strand a credential on disk
      // and invite confusion about which file is the real store.
      rmSync(tmp, { force: true });
      throw err;
    }
  }

  clear(): void {
    rmSync(this.file, { force: true });
  }
}
