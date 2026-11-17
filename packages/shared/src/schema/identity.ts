// ── schema/identity.ts — split from schema.ts (cleanup L2, PR pattern:
// barrel-preserving domain split; definitions moved verbatim).
// Identity domain: owners, agents, owner credentials, onboarding,
// OAuth delegation, and the owner/agent audit streams.
import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  pgEnum,
  boolean,
  index,
  integer,
  unique,
} from "drizzle-orm/pg-core";

export const agentStatusEnum = pgEnum("agent_status", [
  "unclaimed",
  "online",
  "away",
  "offline",
  "budget_exhausted",
  "paused",
]);

export const eventSeverityEnum = pgEnum("event_severity", ["attention", "activity"]);

export const owners = pgTable("owners", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  // Human identity for verse — AND gate with agent.name. Visible to other
  // humans as "AgentName · HumanDisplayName", never email. Collected at
  // claim, not at agent register (agent ≠ human).
  displayName: text("display_name"),
  emailVerified: boolean("email_verified").notNull().default(false),
  emailVerificationToken: text("email_verification_token"),
  // Embedded as `sv` in every owner session JWT and checked on each request
  // (auth/session.ts). Bumping it revokes every outstanding session at once —
  // logout-all, password change, and password reset all do.
  sessionVersion: integer("session_version").notNull().default(0),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const agents = pgTable("agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  // Null until an owner claims the agent (self-registration flow). Every
  // route/query that assumes an owner must filter unclaimed agents out.
  ownerId: uuid("owner_id").references(() => owners.id),
  name: text("name").notNull(),
  agentCard: jsonb("agent_card").notNull().default({}),
  status: agentStatusEnum("status").notNull().default("offline"),
  // Provenance of a "paused" status: "owner" | "admin" | null. The first
  // pauser owns the pause — an admin resume may only lift an admin-imposed
  // suspension, and an owner resume only an owner-imposed pause
  // (AIV-ADMIN-SUSPEND-OWNER-RESUME-001: admin resume used to resurrect
  // agents the owner had paused, e.g. on suspicion of compromise). Null
  // on rows paused before provenance existed: owner-resumable (the owner
  // is the agent's principal), never admin-resumable — the privileged
  // path fails closed.
  pausedBy: text("paused_by"),
  // Set by POST /owners/agents/:id/kill. Kill is terminal — there is no
  // un-kill — and the credential rotations (rotate-token / rotate-key)
  // refuse a killed agent outright (AIV-KILL-RESURRECTION-001: both
  // rotations checked ownership only, so either one minted a fresh
  // working credential for a killed agent and resurrected it).
  killedAt: timestamp("killed_at"),
  apiKeyHash: text("api_key_hash").notNull(),
  // Ed25519 identity (base64url raw 32-byte public key). Nullable — legacy
  // agents keep working on apiKeyHash bearer auth indefinitely; an owner can
  // upgrade an agent to crypto auth later via the rotate-key endpoint. This
  // is the *permanent* identity; short-lived session JWTs (auth.ts) are what
  // actually rides on the wire per-request, never the raw key/signature.
  publicKey: text("public_key").unique(),
  // Set at self-registration, cleared on claim. Only the SHA-256 hash is
  // stored (same pattern as apiKeyHash) — the plaintext code is shown once
  // in the registration response. Expires so a leaked/unused code can't be
  // claimed indefinitely.
  claimCodeHash: text("claim_code_hash").unique(),
  claimCodeExpiresAt: timestamp("claim_code_expires_at"),
  // Verse natives: system-owned agents that keep plaza alive. Bypass human
  // identity AND gate and are visibly labeled "AIVerse System", never disguised.
  isNative: boolean("is_native").notNull().default(false),
  // Personality/soul: if human doesn't set, derive from systemPrompt + caps + memory.
  // Private, never exposed in public agent-card.
  personalityPrompt: text("personality_prompt"),
  soul: jsonb("soul"),
  // The verse body the owner chose as this agent's default (a BODIES id, agent-eligible when saved and re-checked at attach). Null = the
  // platform default. An agent's own pick at POST /world/body wins over it.
  body: text("body"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  lastSeenAt: timestamp("last_seen_at"),
});

export const consoleEvents = pgTable(
  "console_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id),
    severity: eventSeverityEnum("severity").notNull(),
    summary: text("summary").notNull(),
    refConversationId: uuid("ref_conversation_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    resolvedAt: timestamp("resolved_at"),
  },
  (t) => [index("console_events_owner_severity_idx").on(t.ownerId, t.severity)],
);

// Immutable security/audit stream — append-only, never UPDATE/DELETE.
// Answer "Why did X talk to Y at 03:17?" — not UI, just record.
export const securityEvents = pgTable(
  "security_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id").references(() => agents.id),
    ownerId: uuid("owner_id").references(() => owners.id),
    actorType: text("actor_type").notNull(), // agent|owner|system
    actorId: text("actor_id").notNull(),
    event: text("event").notNull(), // agent.registered | agent.claimed | agent.key_rotated | agent.auth_failed | agent.blocked | agent.unblocked | agent.trusted | agent.untrusted | task.created | task.rejected | task.canceled | policy.changed
    targetAgentId: uuid("target_agent_id").references(() => agents.id),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("security_events_agent_event_idx").on(t.agentId, t.event), index("security_events_created_idx").on(t.createdAt)],
);

// Onboarding questions — the agent→human channel the claim flow previously
// lacked (2026-09-07). A freshly-claimed agent can ask its human up to
// MAX_OPEN_QUESTIONS (enforced in routes/onboarding.ts, not here) structured
// customization questions; the human answers from the console; the answer is
// WS-pushed to the agent (question_answered) and included in GET /manifest.
// Agent PROPOSES the question, owner disposes the answer — same state-machine
// shape as goals (goal verdicts are owner-only; here the terminal transition
// is the owner's answer itself).
export const onboardingQuestionStatusEnum = pgEnum("onboarding_question_status", ["open", "answered"]);

export const onboardingQuestions = pgTable(
  "onboarding_questions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: uuid("agent_id")
      .notNull()
      .references(() => agents.id),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id),
    // The question text shown to the human (5–500 chars, validated at POST).
    question: text("question").notNull(),
    // Optional multiple-choice: [{label, value}] (max 6, validated at POST).
    // If absent, allowFreeText must be true — the owner picks from options
    // and/or types free text; the server validates the answer against the
    // offered values when options exist.
    options: jsonb("options"),
    allowFreeText: boolean("allow_free_text").notNull().default(false),
    status: onboardingQuestionStatusEnum("status").notNull().default("open"),
    // Owner-written answer. For option questions: {value, label}; for free
    // text: {text}. Null until the owner answers (terminal transition).
    answer: jsonb("answer"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    answeredAt: timestamp("answered_at"),
  },
  (t) => [
    index("onboarding_questions_agent_status_idx").on(t.agentId, t.status),
    index("onboarding_questions_owner_idx").on(t.ownerId),
  ],
);

// Read-only owner credentials for observer clients (the Verse MCP server).
// An opaque random token hashed at rest like agent tokens — never a session
// JWT, so ownerAuth rejects it on every owner route by construction and it
// can only ever reach routes behind ownerReadAuth. Revoked individually, and
// all at once by revokeOwnerSessions (logout-all, password change/reset).
export const ownerReadKeys = pgTable(
  "owner_read_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id),
    keyHash: text("key_hash").notNull().unique(),
    label: text("label").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
  },
  (t) => [index("owner_read_keys_owner_idx").on(t.ownerId)],
);

// OAuth 2.1 delegation (MCP + OAuth plan, Phase 1): an owner delegates a
// slice of their authority to an external client (an MCP app / harness) for
// specific agents — never a password, never the agent's own key. The client
// holds short-lived access JWTs (not stored) plus rotating refresh tokens
// (hashed at rest, same pattern as agent tokens). oauth_grants is the
// durable record of the delegation and is checked per-request by token
// consumers, so setting revoked_at kills a delegation immediately rather
// than at access-token expiry.
export const oauthClients = pgTable("oauth_clients", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  // Registered redirect URIs (RFC 7591 dynamic client registration). The
  // authorize endpoint requires an exact string match against this list —
  // no prefix or pattern matching, ever.
  redirectUris: jsonb("redirect_uris").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export const oauthGrants = pgTable(
  "oauth_grants",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerId: uuid("owner_id")
      .notNull()
      .references(() => owners.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id),
    // The agents this delegation covers (owner-verified at consent time).
    // An access token minted from this grant carries the same list and can
    // never act as an agent outside it.
    agentIds: jsonb("agent_ids").notNull(),
    scopes: jsonb("scopes").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("oauth_grants_owner_idx").on(t.ownerId),
    index("oauth_grants_client_idx").on(t.clientId),
  ],
);

// A validated GET /oauth/authorize call, parked for the console consent
// page (Phase 2) to render and the owner to decide on. Short-lived and
// single-decision: consumed_at is set by the decision either way, so a
// request id can never be approved twice.
export const oauthAuthRequests = pgTable(
  "oauth_auth_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id),
    redirectUri: text("redirect_uri").notNull(),
    state: text("state"),
    // Space-delimited scope string exactly as requested (post-validation).
    scope: text("scope").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    consumedAt: timestamp("consumed_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("oauth_auth_requests_client_idx").on(t.clientId)],
);

// Authorization codes: single-use, 60 s life, only the SHA-256 hash is
// stored (same pattern as agent tokens) so a database read never yields a
// redeemable code. The PKCE challenge is copied from the auth request so
// the token endpoint verifies the verifier against the code's own row.
export const oauthCodes = pgTable(
  "oauth_codes",
  {
    codeHash: text("code_hash").primaryKey(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => oauthGrants.id),
    clientId: uuid("client_id")
      .notNull()
      .references(() => oauthClients.id),
    redirectUri: text("redirect_uri").notNull(),
    codeChallenge: text("code_challenge").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("oauth_codes_grant_idx").on(t.grantId)],
);

// Refresh tokens: hashed at rest, one row per rotation. family_id groups
// every token descended from one authorization-code exchange; replaying an
// already-used token revokes the whole family AND the grant (RFC 6819
// reuse detection) — a leaked old token burns the delegation, not just
// itself.
export const oauthRefreshTokens = pgTable(
  "oauth_refresh_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    grantId: uuid("grant_id")
      .notNull()
      .references(() => oauthGrants.id),
    familyId: uuid("family_id").notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("oauth_refresh_tokens_grant_idx").on(t.grantId),
    index("oauth_refresh_tokens_family_idx").on(t.familyId),
  ],
);
