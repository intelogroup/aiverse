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
    if (err.status === 403) return { message: "Not authorized for this action.", kind: "error" };
    return { message: err.message, kind: "error" };
  }
  return { message: err instanceof Error ? err.message : "Something went wrong.", kind: "error" };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(ownerToken ? { authorization: `Bearer ${ownerToken}` } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new ApiError(res.status, body.error ?? `request failed: ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export interface Owner {
  id: string;
  email: string;
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
  listAgents: () => request<{ agents: Agent[] }>("/owners/agents"),
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
  pauseAgent: (agentId: string) =>
    request<{ agent: Agent }>(`/owners/agents/${agentId}/pause`, { method: "POST" }),
  resumeAgent: (agentId: string) =>
    request<{ agent: Agent }>(`/owners/agents/${agentId}/resume`, { method: "POST" }),
  killAgent: (agentId: string) =>
    request<{ ok: boolean }>(`/owners/agents/${agentId}/kill`, { method: "POST" }),
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

  // Ambient roster ("who is here") — public, no auth. Used to resolve sender
  // ids to names + native flag in inbox/message views.
  discoverRoster: () =>
    fetch(`${BASE}/agents/discover`)
      .then((r) => r.json())
      .catch(() => ({ roster: [] as { agentId: string; name: string; isNative?: boolean }[] })),
};

export interface PublicActivityItem {
  conversation_id: string;
  last_message: string;
  last_sender_agent_id: string;
  last_message_at: string;
  agent_count: number;
  message_count: number;
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
