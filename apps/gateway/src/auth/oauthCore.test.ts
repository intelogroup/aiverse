import { describe, expect, test } from "bun:test";
import { sign } from "hono/jwt";
import { env } from "@aiverse/shared/env";
import { hashAgentToken } from "./agentToken";
import {
  computeS256Challenge,
  generateAuthorizationCode,
  generateRefreshFamilyId,
  generateRefreshToken,
  hashAuthorizationCode,
  hashRefreshToken,
  isAllowedRedirectUri,
  isScopeSubset,
  oauthIssuer,
  oauthResource,
  parseScope,
  signAccessToken,
  verifyAccessToken,
  verifyPkceS256,
} from "./oauthCore";

// Pure unit tests for the OAuth core: no database, no redis — the module
// under test imports only crypto + JWT + env. (Importing env still runs its
// fail-closed validation, so the run command supplies dummy values for the
// required vars; nothing here connects anywhere.)

// RFC 7636 Appendix B test vector.
const RFC_VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const RFC_CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";

describe("PKCE S256", () => {
  test("computes the RFC 7636 Appendix B challenge", () => {
    expect(computeS256Challenge(RFC_VERIFIER)).toBe(RFC_CHALLENGE);
  });

  test("verifies the correct verifier and rejects a wrong one", () => {
    expect(verifyPkceS256(RFC_VERIFIER, RFC_CHALLENGE)).toBe(true);
    expect(verifyPkceS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXj", RFC_CHALLENGE)).toBe(false);
    expect(verifyPkceS256(RFC_VERIFIER, computeS256Challenge("some-other-verifier-that-is-long-enough-43chars"))).toBe(
      false,
    );
  });

  test("rejects malformed verifiers and challenges", () => {
    expect(verifyPkceS256("too-short", RFC_CHALLENGE)).toBe(false);
    expect(verifyPkceS256("has spaces and is long enough to pass the length check....", RFC_CHALLENGE)).toBe(false);
    expect(verifyPkceS256(42, RFC_CHALLENGE)).toBe(false);
    expect(verifyPkceS256(RFC_VERIFIER, "")).toBe(false);
    expect(verifyPkceS256(RFC_VERIFIER, undefined)).toBe(false);
  });
});

describe("authorization codes and refresh tokens", () => {
  test("codes are unique and only their hash is derivable", () => {
    const a = generateAuthorizationCode();
    const b = generateAuthorizationCode();
    expect(a.code).not.toBe(b.code);
    expect(a.hash).toBe(hashAuthorizationCode(a.code));
    expect(a.hash).toBe(hashAgentToken(a.code));
    expect(a.hash).not.toContain(a.code);
  });

  test("refresh tokens hash with the shared at-rest pattern; families are uuids", () => {
    const t = generateRefreshToken();
    expect(t.hash).toBe(hashRefreshToken(t.token));
    expect(t.hash).toBe(hashAgentToken(t.token));
    expect(generateRefreshFamilyId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("access tokens", () => {
  const claims = { ownerId: "owner-123", scope: "world:observe inbox:read", agents: ["agent-1", "agent-2"] };

  test("sign/verify round-trips the delegation claims", async () => {
    const token = await signAccessToken(claims);
    const verified = await verifyAccessToken(token);
    expect(verified).toEqual(claims);
  });

  test("carries iss = issuer and aud = the MCP resource", async () => {
    expect(oauthResource()).toBe(`${oauthIssuer()}/mcp/agent`);
    const token = await signAccessToken(claims);
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    expect(payload.sub).toBe(claims.ownerId);
    expect(payload.iss).toBe(oauthIssuer());
    expect(payload.aud).toBe(oauthResource());
    expect(payload.exp - payload.iat).toBe(3600);
  });

  test("rejects a token minted for a different audience", async () => {
    const now = Math.floor(Date.now() / 1000);
    const foreign = await sign(
      {
        sub: claims.ownerId,
        iss: oauthIssuer(),
        aud: `${oauthIssuer()}/some-other-resource`,
        scope: claims.scope,
        agents: claims.agents,
        iat: now,
        exp: now + 3600,
      },
      env.JWT_SECRET,
    );
    await expect(verifyAccessToken(foreign)).rejects.toThrow();
  });

  test("rejects an owner session-shaped token (no aud/agents claims)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const sessionLike = await sign({ sub: claims.ownerId, sv: 0, exp: now + 3600 }, env.JWT_SECRET);
    await expect(verifyAccessToken(sessionLike)).rejects.toThrow();
  });

  test("rejects expired tokens and bad signatures", async () => {
    const now = Math.floor(Date.now() / 1000);
    const expired = await sign(
      {
        sub: claims.ownerId,
        iss: oauthIssuer(),
        aud: oauthResource(),
        scope: claims.scope,
        agents: claims.agents,
        iat: now - 7200,
        exp: now - 3600,
      },
      env.JWT_SECRET,
    );
    await expect(verifyAccessToken(expired)).rejects.toThrow();

    const token = await signAccessToken(claims);
    const tampered = `${token.slice(0, -2)}xx`;
    await expect(verifyAccessToken(tampered)).rejects.toThrow();
  });
});

describe("scope parsing", () => {
  test("accepts subsets of the supported set, deduplicated", () => {
    expect(parseScope("world:observe inbox:read")).toEqual(["world:observe", "inbox:read"]);
    expect(parseScope("discover discover")).toEqual(["discover"]);
    expect(parseScope("")).toEqual([]);
    expect(parseScope(undefined)).toEqual([]);
  });

  test("rejects anything outside the supported set", () => {
    expect(parseScope("world:observe admin:all")).toBeNull();
    expect(parseScope("openid")).toBeNull();
  });

  test("subset checks never widen", () => {
    expect(isScopeSubset(["world:observe"], ["world:observe", "world:act"])).toBe(true);
    expect(isScopeSubset(["world:act"], ["world:observe"])).toBe(false);
    expect(isScopeSubset([], ["world:observe"])).toBe(true);
  });
});

describe("redirect URI policy", () => {
  test("https anywhere; http only on loopback", () => {
    expect(isAllowedRedirectUri("https://claude.ai/oauth/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://localhost:8080/callback")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1:53111/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://evil.example.com/callback")).toBe(false);
    expect(isAllowedRedirectUri("http://localhost.evil.example.com/callback")).toBe(false);
  });

  test("rejects non-URLs and other schemes", () => {
    expect(isAllowedRedirectUri("not a url")).toBe(false);
    expect(isAllowedRedirectUri("ftp://localhost/cb")).toBe(false);
    expect(isAllowedRedirectUri("javascript:alert(1)")).toBe(false);
  });
});
