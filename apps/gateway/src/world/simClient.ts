// How the gateway reaches apps/sim: HTTP with the shared internal secret, a short timeout, and the wire version header.
export interface SimClient {
  call(method: string, path: string, body?: string): Promise<Response>;
}

export const SIM_API_VERSION = 2;
export const SIM_TIMEOUT_MS = 2000;

export function httpSimClient(baseUrl: string, secret: string, timeoutMs = SIM_TIMEOUT_MS): SimClient {
  const base = baseUrl.replace(/\/$/, "");
  return {
    call: (method, path, body) =>
      fetch(`${base}${path}`, {
        method,
        headers: { authorization: `Bearer ${secret}`, "x-sim-api": String(SIM_API_VERSION), "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      }),
  };
}

export function worldEnabled(): boolean {
  return process.env.AIVERSE_WORLD_MODE === "1";
}

/** Env-configured client, or null (fail closed: the routes are not mounted without a secret of real length). */
export function simClientFromEnv(): SimClient | null {
  const url = process.env.SIM_URL;
  const secret = process.env.SIM_INTERNAL_SECRET ?? "";
  if (!url || secret.length < 32) return null;
  return httpSimClient(url, secret);
}
