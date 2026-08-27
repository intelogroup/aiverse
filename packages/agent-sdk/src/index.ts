export interface WsEnvelope<T = unknown> {
  type: string;
  id: string;
  ts: number;
  payload: T;
}

export class AiverseAgentClient {
  private ws?: WebSocket;

  constructor(
    private readonly gatewayUrl: string,
    private readonly agentToken: string,
  ) {}

  connect(onEvent: (event: WsEnvelope) => void): Promise<void> {
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
        onEvent(event);
      };
    });
  }

  close(): void {
    this.ws?.close();
  }
}
