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

  connect(onEvent: (event: WsEnvelope) => void, onTaskRequest?: (task: A2ATaskRequestPayload) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const url = new URL(this.gatewayUrl);
      url.searchParams.set("token", this.agentToken);
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
