// How the gateway reaches the look service (experiments/look-service): the photorealistic head-cam behind POST /world/see.
//
// A separate process on purpose: it holds a warm headless Chromium open on the console world, and captures serialize on its
// one page — minutes-scale on a CPU host, seconds on a GPU one. This client is the fail-closed edge: no env, no secret, a
// down service, a wedged capture — everything becomes { ok: false } and the route answers 502 look_unavailable. A frame is
// never fabricated, cached or retried into existence.
export interface LookFrame {
  /** Base64 PNG, 512x288, from the body's head at the pose the gateway passed in. */
  imagePng: string;
  width: number;
  height: number;
  /** Metre-scale depth reduction of the same capture (validFrac, median, centreMedian, ...); null when the rig returned none. */
  depthSummary: unknown;
  /** The service's pose echo after applying the requested pose: where its stand-in body actually stood for the frame. */
  pose: unknown;
  /** In-service render time for the capture itself. */
  renderMs: number | null;
  /** Time spent moving the stand-in body to the requested pose before capturing. */
  poseMs: number | null;
  /** The head rig's camera is level-only; a see is always pitch 0. */
  pitchSupported: boolean;
  capturedAt: string | null;
}

export type LookOutcome =
  | { ok: true; frame: LookFrame; serviceMs: number }
  | { ok: false; reason: "unavailable" | "misconfigured" | "not_ready" | "bad_response" | "timeout" };

export interface LookClient {
  look(agentId: string, position: [number, number], headingDeg: number): Promise<LookOutcome>;
}

/**
 * Capture budget: the service allows a pose move plus a 600 s capture. The default timeout sits just above that; a host
 * that answers faster makes the real number moot. Operators can lower it (LOOK_TIMEOUT_MS) where an edge proxy would
 * kill a long call anyway — a timeout is still a clean 502, never a fake frame.
 */
export const LOOK_TIMEOUT_MS = 660_000;

interface ServiceLookBody {
  ok?: boolean;
  png_b64?: string;
  width?: number;
  height?: number;
  depthSummary?: unknown;
  pose?: unknown;
  renderMs?: number;
  poseMs?: number;
  pitchSupported?: boolean;
  utc?: string;
  error?: string;
}

export function httpLookClient(baseUrl: string, secret: string, timeoutMs = LOOK_TIMEOUT_MS): LookClient {
  const base = baseUrl.replace(/\/$/, "");
  return {
    async look(agentId, position, headingDeg) {
      const t0 = Date.now();
      let r: Response;
      try {
        r = await fetch(`${base}/look`, {
          method: "POST",
          headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
          body: JSON.stringify({ agentId, position, headingDeg }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        // A timeout means the service may well be capturing (it just never answered); a refusal means it never took
        // the work. The route paces the two differently, so they stay distinct here.
        return { ok: false, reason: e instanceof DOMException && e.name === "TimeoutError" ? "timeout" : "unavailable" };
      }
      if (r.status === 401 || r.status === 403) return { ok: false, reason: "misconfigured" };
      if (r.status === 503) return { ok: false, reason: "not_ready" };
      if (r.status !== 200) return { ok: false, reason: "unavailable" };
      const body = (await r.json().catch(() => null)) as ServiceLookBody | null;
      if (!body || typeof body.png_b64 !== "string" || !body.png_b64) return { ok: false, reason: "bad_response" };
      return {
        ok: true,
        serviceMs: Date.now() - t0,
        frame: {
          imagePng: body.png_b64,
          width: body.width ?? 512,
          height: body.height ?? 288,
          depthSummary: body.depthSummary ?? null,
          pose: body.pose ?? null,
          renderMs: typeof body.renderMs === "number" ? body.renderMs : null,
          poseMs: typeof body.poseMs === "number" ? body.poseMs : null,
          pitchSupported: body.pitchSupported === true,
          capturedAt: typeof body.utc === "string" ? body.utc : null,
        },
      };
    },
  };
}

/** Env-configured client, or null (fail closed: /world/see answers 502 until LOOK_SERVICE_URL + a real secret exist). */
export function lookClientFromEnv(): LookClient | null {
  const url = process.env.LOOK_SERVICE_URL;
  const secret = process.env.LOOK_SERVICE_SECRET ?? "";
  if (!url || secret.length < 32) return null;
  const t = Number(process.env.LOOK_TIMEOUT_MS);
  return httpLookClient(url, secret, Number.isFinite(t) && t > 0 ? t : LOOK_TIMEOUT_MS);
}
