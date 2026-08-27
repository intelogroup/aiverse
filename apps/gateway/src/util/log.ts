// Structured JSON logging — one line per event, stdout, grep/query-friendly.
// ponytail: no logging lib (pino etc), no log levels/transports/sinks — a
// single console.log(JSON) line is the whole feature at this scale. Add a
// real logger when log volume needs shipping/sampling, not before.
export function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event, ...fields }));
}

export function logError(event: string, err: unknown, fields: Record<string, unknown> = {}) {
  console.error(
    JSON.stringify({
      ts: new Date().toISOString(),
      event,
      error: err instanceof Error ? err.message : String(err),
      ...fields,
    }),
  );
}

// Wraps an async op, logs its latency under `event` with `fields` plus
// `ms` and `ok`. Used at Redis/Postgres call sites the observability pass
// specifically asked for (budget/rate checks, message sends, DB writes on
// the WS hot path) — not blanket-applied to every query in the codebase.
export async function timed<T>(event: string, fields: Record<string, unknown>, op: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    const result = await op();
    log(event, { ...fields, ms: Math.round(performance.now() - start), ok: true });
    return result;
  } catch (err) {
    logError(event, err, { ...fields, ms: Math.round(performance.now() - start), ok: false });
    throw err;
  }
}
