// Rolling 60 s HTTP status-class counts: one counter row per second, reused. No dependency, no per-request logging.
const WINDOW_S = 60;
type Row = { sec: number; c: [number, number, number, number, number] }; // 1xx..5xx
const rows: Row[] = Array.from({ length: WINDOW_S }, () => ({ sec: -1, c: [0, 0, 0, 0, 0] }));

export function recordStatus(status: number, atMs = Date.now()): void {
  const sec = Math.floor(atMs / 1000), r = rows[sec % WINDOW_S];
  if (r.sec !== sec) { r.sec = sec; r.c = [0, 0, 0, 0, 0]; }
  const i = Math.floor(status / 100) - 1;
  if (i >= 0 && i < 5) r.c[i]++;
}

export function statusWindow(atMs = Date.now()): Record<"1xx" | "2xx" | "3xx" | "4xx" | "5xx" | "total", number> {
  const sec = Math.floor(atMs / 1000), t = [0, 0, 0, 0, 0];
  for (const r of rows) if (r.sec <= sec && r.sec > sec - WINDOW_S) r.c.forEach((n, i) => (t[i] += n));
  return { "1xx": t[0], "2xx": t[1], "3xx": t[2], "4xx": t[3], "5xx": t[4], total: t.reduce((a, b) => a + b, 0) };
}
