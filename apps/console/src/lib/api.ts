const BASE = "/api";

let ownerToken: string | null = localStorage.getItem("aiverse_owner_token");
let ownerEmail: string | null = localStorage.getItem("aiverse_owner_email");

export function setOwnerToken(t: string | null) {
  ownerToken = t;
  if (t) localStorage.setItem("aiverse_owner_token", t);
  else localStorage.removeItem("aiverse_owner_token");
}
export function getOwnerToken() {
  return ownerToken;
}
export function setOwnerEmail(e: string | null) {
  ownerEmail = e;
  if (e) localStorage.setItem("aiverse_owner_email", e);
  else localStorage.removeItem("aiverse_owner_email");
}
export function getOwnerEmail() {
  return ownerEmail;
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

export interface Agent {
  id: string;
  name: string;
  agentCard: { capabilities: string[]; description?: string };
  status: string;
  lastSeenAt?: string;
}
export interface Wallet {
  dailyTokenBudget: number;
  autonomyMode: "observe" | "assist" | "autonomous";
}
export interface PublicActivityItem {
  conversation_id: string;
  last_message: string;
  last_sender_agent_id: string;
  last_message_at: string;
  agent_count: number;
  message_count: number;
}
export interface RosterEntry {
  agentId: string;
  name: string;
  status: string;
  isNative: boolean;
  capabilities: string[];
}
export interface ConversationMeta {
  conversationId: string;
  isPublic: boolean;
  lastMessageAt: string;
  messageCount: number;
  participants: string[];
}
export interface ChatMessage {
  id: string;
  conversationId?: string;
  senderAgentId: string;
  content: string;
  createdAt: string;
  replyToId?: string | null;
}

export const api = {
  login: (email: string, password: string) =>
    request<{ token: string; owner: { id: string; email: string } }>("/owners/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),
  listAgents: () => request<{ agents: Agent[] }>("/owners/agents"),
  networkStats: () => request<{ onlineAgents: number }>("/owners/network/stats"),
  agentConversations: (agentId: string) =>
    request<{ conversations: ConversationMeta[] }>(`/owners/agents/${agentId}/conversations`),
  conversationMessages: (conversationId: string) =>
    request<{ messages: ChatMessage[] }>(`/owners/conversations/${conversationId}/messages`),
  getWallet: (agentId: string) => request<{ wallet: Wallet }>(`/owners/agents/${agentId}/wallet`),
  setAutonomy: (agentId: string, autonomyMode: Wallet["autonomyMode"]) =>
    request<{ wallet: Wallet }>(`/owners/agents/${agentId}/wallet`, {
      method: "PATCH",
      body: JSON.stringify({ autonomyMode }),
    }),
  pauseAgent: (agentId: string) => request<{ agent: Agent }>(`/owners/agents/${agentId}/pause`, { method: "POST" }),
  resumeAgent: (agentId: string) => request<{ agent: Agent }>(`/owners/agents/${agentId}/resume`, { method: "POST" }),
  killAgent: (agentId: string) => request<{ ok: boolean }>(`/owners/agents/${agentId}/kill`, { method: "POST" }),
  agentsStats: () =>
    request<{ stats: Record<string, { sends1h: number; joins1h: number; lastMessage: string | null; lastMessageAt: string | null; lastConversationId: string | null }> }>(
      "/owners/agents-stats",
    ),
  publicActivity: () => request<{ activity: PublicActivityItem[] }>("/public/activity"),
  publicConversation: (id: string) =>
    request<{ messages: { id: string; content: string; senderAgentId: string; createdAt?: string }[] }>(
      `/public/conversations/${id}`,
    ),
  discoverRoster: () =>
    fetch(`${BASE}/agents/discover`)
      .then((r) => r.json())
      .catch(() => ({ roster: [] as RosterEntry[] })),
  wsTicket: () =>
    request<{ ticket: string }>("/owners/ws-ticket", { method: "POST" }),
};
