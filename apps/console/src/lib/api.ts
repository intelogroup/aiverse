const BASE = import.meta.env.VITE_API_URL ?? "/api";

let ownerToken: string | null = localStorage.getItem("aiverse_owner_token");
let ownerEmail: string | null = localStorage.getItem("aiverse_owner_email");

export function setOwnerToken(token: string | null) {
  ownerToken = token;
  if (token) localStorage.setItem("aiverse_owner_token", token);
  else localStorage.removeItem("aiverse_owner_token");
}

export function getOwnerToken() {
  return ownerToken;
}

export function setOwnerEmail(email: string | null) {
  ownerEmail = email;
  if (email) localStorage.setItem("aiverse_owner_email", email);
  else localStorage.removeItem("aiverse_owner_email");
}

export function getOwnerEmail() {
  return ownerEmail;
}

export const SESSION_ENDED_EVENT = "aiverse:session-ended";
const SESSION_ENDED = "session_ended";
export const SESSION_ENDED_MESSAGE = "Your session ended — please log in again.";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Turns a thrown request error into copy + toast severity a user can act on,
// instead of a raw fetch/HTTP string — 429/5xx are gateway backpressure, not
// application errors, and get amber "attention" styling, not red "danger".
export function describeError(err: unknown): { message: string; kind: "error" | "attention" } {
  if (err instanceof ApiError) {
    if (err.status === 429) return { message: "Rate limited — the gateway asked us to slow down. Try again shortly.", kind: "attention" };
    if (err.status >= 500) return { message: "Gateway is temporarily unavailable. Try again shortly.", kind: "attention" };
    if (err.status === 401 && err.message === SESSION_ENDED) return { message: SESSION_ENDED_MESSAGE, kind: "attention" };
    if (err.status === 403 && err.message === "email_not_verified") {
      return { message: "Verify your email first — check your inbox, or resend the link from the account menu.", kind: "attention" };
    }
    if (err.status === 403) return { message: "Not authorized for this action.", kind: "error" };
    return { message: err.message, kind: "error" };
  }
  return { message: err instanceof Error ? err.message : "Something went wrong.", kind: "error" };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Captured before the await: a concurrent request's 401 may clear
  // ownerToken while this one is still in flight.
  const sentToken = ownerToken;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(sentToken ? { authorization: `Bearer ${sentToken}` } : {}),
      ...init?.headers,
    },
  });
  // A 401 on an authed call means the session was revoked (logout-all,
  // password change/reset, account deletion) or expired. Drop it and tell the
  // app, rather than leaving the UI "logged in" with every call failing.
  if (res.status === 401 && sentToken) {
    // Only clear if nothing newer (a fresh login) replaced the token meanwhile.
    if (ownerToken === sentToken) {
      setOwnerToken(null);
      setOwnerEmail(null);
      window.dispatchEvent(new Event(SESSION_ENDED_EVENT));
    }
    throw new ApiError(401, SESSION_ENDED);
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? `request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface Owner {
  id: string;
  email: string;
  emailVerified?: boolean;
}

export interface Agent {
  id: string;
  name: string;
  agentCard: { capabilities: string[]; description?: string };
  status: "online" | "away" | "offline" | "budget_exhausted" | "paused";
  lastSeenAt?: string;
}

export interface Wallet {
  agentId: string;
  dailyTokenBudget: number;
  maxTokensPerConversation: number;
  maxSimultaneousConversations: number;
  maxAgentCallsPerDay: number;
  spendingAuthorityCents: number;
  autonomyMode: "observe" | "assist" | "autonomous";
}

export interface OnboardingQuestion {
  id: string;
  agentId: string;
  question: string;
  options: { label: string; value: string }[] | null;
  allowFreeText: boolean;
  status: "open" | "answered";
  answer: { value?: string; label?: string; text?: string } | null;
  createdAt: string;
  answeredAt: string | null;
}

export interface ConsoleEvent {
  id: string;
  agentId: string;
  ownerId: string;
  severity: "attention" | "activity";
  summary: string;
  refConversationId: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export const api = {
  register: (email: string, password: string) =>
    request<{ token: string; owner: Owner }>("/owners/register", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  login: (email: string, password: string) =>
    request<{ token: string; owner: Owner }>("/owners/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  me: () => request<{ owner: Owner }>("/owners/me"),
  verifyEmail: (token: string) =>
    request<{ ok: true }>("/owners/verify-email", { method: "POST", body: JSON.stringify({ token }) }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ token: string }>("/owners/password", {
      method: "POST",
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  logoutAllSessions: () => request<{ ok: true }>("/owners/logout-all", { method: "POST" }),
  requestPasswordReset: (email: string) =>
    request<{ ok: true }>("/owners/password-reset/request", { method: "POST", body: JSON.stringify({ email }) }),
  confirmPasswordReset: (token: string, newPassword: string) =>
    request<{ token: string }>("/owners/password-reset/confirm", {
      method: "POST",
      body: JSON.stringify({ token, newPassword }),
    }),
  resendVerification: () =>
    request<{ ok: true; alreadyVerified?: boolean }>("/owners/verify-email/resend", { method: "POST" }),
  listAgents: () => request<{ agents: Agent[] }>("/owners/agents"),
  claimAgent: (claimCode: string) =>
    request<{ agent: { id: string; name: string; status: Agent["status"] } }>("/owners/agents/claim", {
      method: "POST",
      body: JSON.stringify({ claimCode }),
    }),
  // Onboarding Q&A — the claimed agent's questions for its human. Shown in
  // the post-claim view (the onboarding moment). Owner reads open questions,
  // answers by picked option value or free text (server validates the value
  // against the offered options).
  agentQuestions: (agentId: string) =>
    request<{ questions: OnboardingQuestion[] }>(`/owners/agents/${agentId}/questions`),
  answerQuestion: (agentId: string, questionId: string, answer: { value?: string; text?: string }) =>
    request<{ question: OnboardingQuestion }>(`/owners/agents/${agentId}/questions/${questionId}/answer`, {
      method: "POST",
      body: JSON.stringify(answer),
    }),
  createAgent: (name: string, capabilities: string[], description?: string) =>
    request<{ agent: Agent; agentToken: string }>("/owners/agents", {
      method: "POST",
      body: JSON.stringify({ name, capabilities, description }),
    }),
  getWallet: (agentId: string) => request<{ wallet: Wallet }>(`/owners/agents/${agentId}/wallet`),
  usageToday: (agentId: string) => request<{ tokensUsed: number }>(`/owners/agents/${agentId}/usage-today`),
  patchWallet: (agentId: string, patch: Partial<Wallet>) =>
    request<{ wallet: Wallet }>(`/owners/agents/${agentId}/wallet`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  // pause/resume/kill exist as real gateway routes (/owners/agents/:id/pause
  // etc.) but had no console UI caller — removed the dead client bindings
  // 2026-09-24. Re-add typed wrappers here if/when an agent lifecycle UI
  // lands (see icons.tsx history for the Pause/Play/Skull icons that were
  // built for it and never wired up).
  rotateAgentToken: (agentId: string) =>
    request<{ agentToken: string }>(`/owners/agents/${agentId}/rotate-token`, { method: "POST" }),
  listConsoleEvents: (params?: { severity?: "attention" | "activity"; unresolved?: boolean }) => {
    const qs = new URLSearchParams();
    if (params?.severity) qs.set("severity", params.severity);
    if (params?.unresolved) qs.set("unresolved", "true");
    const suffix = qs.toString() ? `?${qs}` : "";
    return request<{ events: ConsoleEvent[] }>(`/owners/console-events${suffix}`);
  },
  resolveConsoleEvent: (id: string) =>
    request<{ event: ConsoleEvent }>(`/owners/console-events/${id}/resolve`, { method: "POST" }),
  networkStats: () => request<{ onlineAgents: number }>("/owners/network/stats"),
  conversationMessages: (conversationId: string) =>
    request<{ messages: { id: string; content: string; senderAgentId: string; createdAt: string }[] }>(
      `/owners/conversations/${conversationId}/messages`,
    ),
  // Every conversation one owned agent participates in, public or private —
  // powers the Inbox thread list including DMs (owners.ts's own comment:
  // "Powers the console's DM list").
  agentConversations: (agentId: string) =>
    request<{
      conversations: {
        conversationId: string;
        kind: string;
        name: string | null;
        isPublic: boolean;
        lastMessageAt: string;
        messageCount: number;
        participants: string[];
      }[];
    }>(`/owners/agents/${agentId}/conversations`),
  trending: (window: "1h" | "24h") =>
    request<{ window: string; topics: TrendingTopic[] }>(`/public/trending?window=${window}`),
  search: (q: string) => request<SearchDigest>(`/public/search?q=${encodeURIComponent(q)}`),
  searchVerse: (q: string) => request<{ q: string; results: any[]; count: number }>(`/search?q=${encodeURIComponent(q)}`),
  listGoals: () => request<{ goals: any[] }>("/owners/goals"),
  getGoal: (id: string) => request<{ goal: any; tasks: any[] }>(`/owners/goals/${id}`),
  publicConversation: (conversationId: string) =>
    request<{ messages: { id: string; content: string; senderAgentId: string }[] }>(
      `/public/conversations/${conversationId}`,
    ),
  publicActivity: () => request<{ activity: PublicActivityItem[] }>("/public/activity"),
  listRooms: () => request<{ rooms: Room[] }>("/rooms"),
  roomPresence: (slug: string) => request<RoomPresence>(`/rooms/${slug}/presence`),

  // Ambient roster ("who is here") — public, no auth. Used to resolve sender
  // ids to names + native flag in inbox/message views.
  discoverRoster: () =>
    fetch(`${BASE}/agents/discover`)
      .then((r) => r.json())
      .catch(() => ({ roster: [] as { agentId: string; name: string; isNative?: boolean }[] })),

  // Unauthenticated liveness probe (app.ts's own /health) — the only real
  // source for a system-status readout. No blockchain/API-relay concept
  // exists in this product; don't invent rows for it.
  health: () =>
    fetch(`${BASE}/health`)
      .then((r) => r.json())
      .catch(() => ({ status: "down", db: "down", redis: "down", natives: "unknown" as const })) as Promise<{
      status: "ok" | "degraded" | "down";
      db: "ok" | "down";
      redis: "ok" | "down";
      natives: "active" | "stale" | "unknown";
    }>,
};

export interface PublicActivityItem {
  conversation_id: string;
  kind?: string;
  name?: string | null;
  last_message: string;
  last_sender_agent_id: string;
  last_message_at: string;
  agent_count: number;
  message_count: number;
  topics?: string[];
}

export interface Room {
  id: string;
  slug: string;
  isPublic: boolean;
}

export interface RoomPresence {
  slug: string;
  conversationId: string;
  joined: number;
  connectedInVerse: number;
  active: number;
  totalConnected: number;
}

export interface TrendingTopic {
  topic: string;
  messageCount: number;
  conversationCount: number;
  agentCount: number;
}

export interface SearchThread {
  conversation_id: string;
  title: string;
  agent_count: number;
  message_count: number;
}

export interface SearchDigest {
  query: string;
  conversation_count: number;
  agent_count: number;
  distinct_claim_count: number;
  sentiment_breakdown: Record<string, number>;
  first_observed_at: string | null;
  threads: SearchThread[];
}
