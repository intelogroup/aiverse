/**
 * Admin CLI (SPEC §9 — the smallest usable admin surface).
 *   bun run admin -- seed-event <seed.json> <codes.local.json>
 *   bun run admin -- schedule|pause|cancel|end <event-id>
 *   bun run admin -- ledger <event-id>
 *   bun run admin -- claims <event-id> [verdict]
 *   bun run admin -- public-state <slug>
 * Env: HUNT_API_URL (default http://localhost:8787), HUNT_ADMIN_TOKEN.
 * The seed file holds event + prizes + hints WITHOUT codes; codes live in
 * the separate codes file (never committed), matched by label_public.
 */
import { readFileSync } from "node:fs";

const base = process.env.HUNT_API_URL ?? "http://localhost:8787";
const token = process.env.HUNT_ADMIN_TOKEN ?? "dev-admin-token";

async function api(method: string, path: string, body?: unknown, admin = true): Promise<any> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(admin ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    console.error(`HTTP ${res.status} ${method} ${path}:`, parsed);
    process.exit(1);
  }
  return parsed;
}

const [cmd, ...rest] = process.argv.slice(2);

switch (cmd) {
  case "seed-event": {
    const [seedPath, codesPath] = rest;
    if (!seedPath || !codesPath) {
      console.error("usage: seed-event <seed.json> <codes.local.json>");
      process.exit(2);
    }
    const seed = JSON.parse(readFileSync(seedPath, "utf8"));
    const codes = JSON.parse(readFileSync(codesPath, "utf8")) as Record<string, string>;
    const ev = await api("POST", "/v1/admin/events", seed.event);
    console.log("event:", ev);
    const prizes = (seed.prizes ?? []).map((p: any) => {
      const code = codes[p.label_public];
      if (!code) {
        console.error(`no code in codes file for prize "${p.label_public}"`);
        process.exit(1);
      }
      return { ...p, code };
    });
    if (prizes.length) console.log("prizes:", await api("POST", `/v1/admin/events/${ev.id}/prizes:bulk`, { prizes }));
    if (seed.hints?.length) console.log("hints:", await api("POST", `/v1/admin/events/${ev.id}/hints:bulk`, { hints: seed.hints }));
    console.log("event_id:", ev.id);
    break;
  }
  case "schedule":
  case "pause":
  case "cancel":
  case "end": {
    console.log(await api("POST", `/v1/admin/events/${rest[0]}/${cmd}`));
    break;
  }
  case "ledger": {
    console.log(JSON.stringify(await api("GET", `/v1/admin/events/${rest[0]}/ledger`), null, 2));
    break;
  }
  case "claims": {
    const q = rest[1] ? `?verdict=${encodeURIComponent(rest[1])}` : "";
    console.log(JSON.stringify(await api("GET", `/v1/admin/events/${rest[0]}/claims${q}`), null, 2));
    break;
  }
  case "public-state": {
    console.log(JSON.stringify(await api("GET", `/v1/events/${rest[0]}/state`, undefined, false), null, 2));
    break;
  }
  default:
    console.error("commands: seed-event | schedule | pause | cancel | end | ledger | claims | public-state");
    process.exit(2);
}
