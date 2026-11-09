/** Browser-hosted physical agent transport. The host binds the token to one body;
 * it is distinct from the social gateway and never exposes debug/teleport APIs. */
export type EmbodiedAction =
  | { type: "go_to" | "run_to"; point: [number, number] }
  | { type: "go_to" | "run_to"; place: string }
  | { type: "face"; headingDeg: number }
  | { type: "wait"; seconds: number }
  | { type: "play"; clip: string; seconds?: number }
  | { type: "sit"; sittable?: string }
  | { type: "stand" }
  | { type: "stop" };
export class EmbodiedAgentClient {
  constructor(private readonly origin: string, private readonly token: string) {}
  private async request(path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(new URL(path, this.origin), {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) throw new Error(`embodied host ${res.status}: ${await res.text()}`);
    return res.json();
  }
  observe(): Promise<unknown> { return this.request("/observe"); }
  map(): Promise<unknown> { return this.request("/map"); }
  async act(action: EmbodiedAction): Promise<unknown> {
    // No implicit retries: retrying a completed physical action can move twice.
    const heartbeat = setInterval(() => {
      void this.request("/heartbeat").catch(() => {});
    }, 5000);
    try {
      return await this.request("/act", { id: crypto.randomUUID(), action });
    } finally {
      clearInterval(heartbeat);
    }
  }
}
