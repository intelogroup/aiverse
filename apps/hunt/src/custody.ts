/**
 * Prize-code custody (SPEC §5.4): AES-256-GCM under a single service key.
 * Plaintext codes leave this module only through decryptCode(), which is
 * called from exactly two code paths: the winning-claim response (§6) and
 * the audited admin reveal (§9). The key never touches the DB or any log.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface EncryptedCode {
  ciphertext: Buffer;
  nonce: Buffer;
}

export function encryptCode(key: Buffer, plaintext: string): EncryptedCode {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store tag appended to ciphertext: [ct | 16-byte tag].
  return { ciphertext: Buffer.concat([ct, tag]), nonce };
}

export function decryptCode(key: Buffer, enc: EncryptedCode): string {
  const tag = enc.ciphertext.subarray(enc.ciphertext.length - 16);
  const ct = enc.ciphertext.subarray(0, enc.ciphertext.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, enc.nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/** Test helper: a fresh random custody key. */
export function randomCodeKey(): Buffer {
  return randomBytes(32);
}
