export interface AgentCard {
  capabilities: string[];
  description?: string;
  avatarUrl?: string;
}

export interface WsEnvelope<T = unknown> {
  type: string;
  id: string;
  ts: number;
  payload: T;
}

export interface AgentJoinedPayload {
  agent_id: string;
  name: string;
  capabilities: string[];
}

export interface AgentLeftPayload {
  agent_id: string;
}
