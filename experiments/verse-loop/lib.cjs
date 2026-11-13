// verse-loop/lib.cjs — tiny client + logger for multi-agent experiments against a LOCAL stack (never production).
// Each experiment onboards its own agents (fresh fictional owners, local DB), runs a short scenario and writes one result row.
const fs = require("fs"), crypto = require("crypto"), path = require("path"), { execSync } = require("child_process");
const API = process.env.VERSE_API || "http://127.0.0.1:3010";
const OUT = process.env.LOOP_OUT || path.join(__dirname, "out"); fs.mkdirSync(OUT, { recursive: true });
const RUN = process.env.LOOP_RUN || new Date().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now();
let EXP = "setup"; const events = [];
function setExp(id) { EXP = id; events.length = 0; }
function log(event, data = {}) { const row = { t: new Date().toISOString(), run: RUN, exp: EXP, event, ...data }; events.push(row); fs.appendFileSync(path.join(OUT, "events.jsonl"), JSON.stringify(row) + "\n"); }
async function http(method, p, tok, body) {
  const r = await fetch(API + p, { method, headers: { "content-type": "application/json", ...(tok ? { authorization: `Bearer ${tok}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { s: r.status, j: await r.json().catch(() => ({})) };
}
/** LOCAL ONLY: the claim limiter is 5 per IP then 1 per 180 s (owners.ts), which would make a 15-agent test take 30 minutes. Clear the
 *  local bucket before a claim; refused unless the API is on loopback. The limiter itself is not under test here. */
function clearClaimBucket() { if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(API)) return; try { execSync("for k in $(redis-cli --scan --pattern '*claim:*'); do redis-cli del \"$k\" >/dev/null; done", { stdio: "ignore", shell: "/bin/bash" }); } catch {} }
class Agent {
  constructor(label) { this.label = label; this.acts = 0; this.refused = 0; }
  /** Owner + self-registered agent + claim + (optionally) a body. Claims are rate limited per IP: callers space them out. */
  async onboard(opts = {}) {
    const email = `jimkalinov+vl${RUN}${this.label.replace(/\W/g, "")}@gmail.com`;
    this.owner = (await http("POST", "/owners/register", null, { email, password: crypto.randomBytes(12).toString("hex") })).j.token;
    const reg = await http("POST", "/agents/register", null, { name: `${this.label}${Math.random().toString(36).slice(2, 5)}`, capabilities: ["explore"], description: "verse-loop experiment agent" });
    this.tok = reg.j.agentToken; this.agentId = reg.j.agentId;
    for (let k = 0; k < 8; k++) { clearClaimBucket(); const c = await http("POST", "/owners/agents/claim", this.owner, { claimCode: reg.j.claimCode }); if (c.s === 200) { this.visit = c.j.visit; break; } if (c.s === 429) await sleep(5000 * (k + 1)); else { this.claimErr = c.s; break; } }
    if (opts.visit) await http("POST", `/owners/agents/${this.agentId}/visits`, this.owner, opts.visit);
    if (opts.body !== false) { const b = await http("POST", "/world/body", this.tok, opts.body ? { body: opts.body } : {}); this.attach = b.s; this.attachJ = b.j; }
    return this;
  }
  /** Submit an action and wait for it to settle. Returns {status, ms, detail, blockedBy}. */
  async act(action, maxWaitMs = 180000) {
    const id = `a${now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; const t0 = now();
    const sub = await http("POST", "/world/act", this.tok, { id, action }); this.acts++;
    if (sub.s !== 202) { this.refused++; return { status: `submit_${sub.s}`, detail: sub.j.error || sub.j.message, ms: now() - t0 }; }
    while (now() - t0 < maxWaitMs) {
      const g = await http("GET", `/world/act/${id}?waitMs=10000`, this.tok);
      if (g.s === 429) { await sleep(1000); continue; }
      const a = g.j.act; if (g.s !== 200 || a?.state === "settled") { const o = a?.outcome || {}; return { status: o.status || g.s, detail: o.detail, blockedBy: o.blockedBy, ms: now() - t0 }; }
    }
    return { status: "harness_timeout", ms: now() - t0 };
  }
  async observe() { for (let k = 0; k < 6; k++) { const r = await http("GET", "/world/observe", this.tok); if (r.s === 200) return r.j.observation; if (r.s === 429) await sleep(800); else return null; } return null; }
  async pos() { const o = await this.observe(); return o && o.body ? [o.body.x, o.body.z] : null; }
  say(text, to) { return this.act({ type: "say", text, ...(to ? { to } : {}) }, 30000); }
  async detach() { return http("DELETE", "/world/body", this.tok); }
}
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
/** Result row: id, the pre-registered criterion, pass/fail, metrics, notes. */
function result(id, criterion, pass, metrics = {}, notes = "") {
  const row = { run: RUN, id, criterion, pass: !!pass, metrics, notes, t: new Date().toISOString() };
  fs.appendFileSync(path.join(OUT, "results.jsonl"), JSON.stringify(row) + "\n");
  console.log(`${pass ? "PASS" : "FAIL"} ${id}  ${criterion}\n     ${JSON.stringify(metrics)}${notes ? "\n     " + notes : ""}`);
  return row;
}
module.exports = { API, OUT, RUN, sleep, now, http, Agent, dist, log, setExp, result };
