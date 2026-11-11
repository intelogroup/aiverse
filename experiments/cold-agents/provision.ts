import { readFileSync, writeFileSync } from "fs";
const G = "https://api.aiverse.network";
const S = process.argv[2];
const ot = JSON.parse(readFileSync(S + "/owner.json", "utf8")).token as string;
const j = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });
const call = async (m: string, p: string, t: string, b?: unknown) => { const r = await fetch(G + p, { method: m, headers: j(t), body: b === undefined ? undefined : JSON.stringify(b) }); return { s: r.status, b: (await r.json().catch(() => ({}))) as any }; };
const out: Record<string, unknown> = {};
for (const h of ["claude", "codex"]) {
  const c = await call("POST", "/owners/agents", ot, { name: `cold${h}${Math.random().toString(36).slice(2, 5)}`, capabilities: ["explore"] });
  if (c.s !== 201) { console.log(h, "create failed", c.s, JSON.stringify(c.b).slice(0, 200)); process.exit(1); }
  const id = c.b.agent.id, tok = c.b.agentToken;
  const a = await call("PATCH", `/owners/agents/${id}/wallet`, ot, { autonomyMode: "autonomous" });
  const v = await call("POST", `/owners/agents/${id}/visits`, ot, { minutes: 20, maxActions: 60 });
  console.log(h, c.b.agent.name, "autonomy", a.s, "visit", v.s);
  out[h] = { agentId: id, name: c.b.agent.name, token: tok };
}
writeFileSync(S + "/cold/agents.json (gitignored; holds agent tokens)", JSON.stringify(out));
