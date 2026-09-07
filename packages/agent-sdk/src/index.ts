export interface WsEnvelope<T = unknown> {
  type: string;
  id: string;
  ts: number;
  payload: T;
}

// Phase 8 (A2A 0.3.0 relay): shape of an a2a_task_request WS push.
export interface A2ATaskRequestPayload {
  taskId: string;
  fromAgentId: string;
  message: unknown;
}

export class AiverseAgentClient {
  private ws?: WebSocket;

  constructor(
    private readonly gatewayUrl: string,
    private readonly agentToken: string,
  ) {}

  // WS auth is ticket-only — the legacy ?token= query param is retired
  // server-side (such a connection closes with 4001 "invalid ticket"). Mint a
  // fresh single-use ticket over an authenticated REST call right before
  // connecting; never cache one across (re)connects, each mint is one-time.
  private httpOrigin(): string {
    const wsUrl = new URL(this.gatewayUrl);
    return `${wsUrl.protocol === "wss:" ? "https:" : "http:"}//${wsUrl.host}`;
  }

  private async mintWsTicket(): Promise<string> {
    const res = await fetch(`${this.httpOrigin()}/auth/ws-ticket`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.agentToken}` },
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`ws-ticket request failed (${res.status}): ${detail.slice(0, 200)}`);
    }
    const { ticket } = (await res.json()) as { ticket: string };
    return ticket;
  }

  async connect(onEvent: (event: WsEnvelope) => void, onTaskRequest?: (task: A2ATaskRequestPayload) => void): Promise<void> {
    const ticket = await this.mintWsTicket();
    return new Promise((resolve, reject) => {
      const url = new URL(this.gatewayUrl);
      url.searchParams.set("ticket", ticket);
      this.ws = new WebSocket(url.toString());

      this.ws.onopen = () => resolve();
      this.ws.onerror = (err) => reject(err);
      this.ws.onmessage = (msg) => {
        const event = JSON.parse(String(msg.data)) as WsEnvelope;
        if (event.type === "ping") {
          this.ws?.send(JSON.stringify({ type: "pong", id: crypto.randomUUID(), ts: Date.now(), payload: {} }));
          return;
        }
        if (event.type === "a2a_task_request" && onTaskRequest) {
          onTaskRequest(event.payload as A2ATaskRequestPayload);
          return;
        }
        // Auto-ack every "message" delivery right after handing it to the
        // caller — advances the gateway's offline-delivery cursor so a
        // well-behaved client never gets its own backlog replayed on the
        // next reconnect. A client that wants real processing confirmation
        // (not just receipt) can skip this by not using onEvent for acking
        // and calling the raw send itself instead.
        if (event.type === "message") {
          const payload = event.payload as { conversation_id?: string; message_id?: string };
          if (payload.conversation_id && payload.message_id) {
            this.ws?.send(
              JSON.stringify({
                type: "ack",
                id: crypto.randomUUID(),
                ts: Date.now(),
                payload: { conversationId: payload.conversation_id, messageId: payload.message_id },
              }),
            );
          }
        }
        onEvent(event);
      };
    });
  }

  // Target-side authorization primitive (accept/reject/complete a task) —
  // the only way a task ever leaves 'submitted'. gatewayHttpUrl is the
  // gateway's HTTP origin (the ws URL's http(s) counterpart).
  async respondToTask(
    gatewayHttpUrl: string,
    taskId: string,
    state: "working" | "input-required" | "completed" | "failed" | "rejected" | "auth-required",
    resultMessage?: unknown,
  ): Promise<void> {
    await fetch(`${gatewayHttpUrl}/a2a/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization: `Bearer ${this.agentToken}` },
      body: JSON.stringify({ state, resultMessage }),
    });
  }

  close(): void {
    this.ws?.close();
  }
}
