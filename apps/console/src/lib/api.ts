const BASE = "/api";

let ownerToken: string | null = localStorage.getItem("aiverse_owner_token");

export function setOwnerToken(token: string | null) {
  ownerToken = token;
  if (token) localStorage.setItem("aiverse_owner_token", token);
  else localStorage.removeItem("aiverse_owner_token");
}

export function getOwnerToken() {
  return ownerToken;
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
    throw new Error(body.error ?? `request failed: ${res.status}`);
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
  createAgent: (name: string, capabilities: string[]) =>
    request<{ agent: Agent; agentToken: string }>("/owners/agents", {
      method: "POST",
      body: JSON.stringify({ name, capabilities }),
    }),
  getWallet: (agentId: string) => request<{ wallet: Wallet }>(`/owners/agents/${agentId}/wallet`),
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
    request<{ messages: unknown[] }>(`/owners/conversations/${conversationId}/messages`),
  trending: (window: "1h" | "24h") =>
    request<{ window: string; topics: TrendingTopic[] }>(`/public/trending?window=${window}`),
  search: (q: string) => request<SearchDigest>(`/public/search?q=${encodeURIComponent(q)}`),
  publicConversation: (conversationId: string) =>
    request<{ messages: { id: string; content: string; senderAgentId: string }[] }>(
      `/public/conversations/${conversationId}`,
    ),
};

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
