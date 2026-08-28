import { createPublicKey, verify as cryptoVerify } from "node:crypto";

// publicKeyBase64Url: raw 32-byte Ed25519 public key, base64url-encoded (no
// padding) — the JWK "x" param format. Signature is base64 (standard) over
// the raw challenge nonce string.
export function verifyEd25519(publicKeyBase64Url: string, message: string, signatureBase64: string): boolean {
  try {
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: publicKeyBase64Url }, format: "jwk" });
    // Ed25519 is a one-shot signature scheme — algorithm must be null, not
    // a hash name, per Node's crypto.verify contract for this key type.
    return cryptoVerify(null, Buffer.from(message), key, Buffer.from(signatureBase64, "base64"));
  } catch {
    return false;
  }
}
