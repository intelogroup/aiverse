// E16 score: read the three agents' final observe + decision logs. node e16_score.cjs <dir> <arm>
const fs = require("fs"); const { http, dist, result, setExp } = require("./lib.cjs");
(async () => { const dir = process.argv[2], arm = process.argv[3]; setExp("E16-" + arm); const names = ["ada", "bo", "cy"]; const S = {};
  for (const n of names) { const tok = fs.readFileSync(`${dir}/${n}.token`, "utf8").trim(); const o = await http("GET", "/world/observe", tok); S[n] = { ok: o.s === 200, pos: o.s === 200 ? [o.j.observation.body.x, o.j.observation.body.z] : null, heard: o.s === 200 ? o.j.observation.heard.map((h) => ({ name: h.name, text: h.text })) : [] };
    const log = fs.existsSync(`${dir}/${n}.jsonl`) ? fs.readFileSync(`${dir}/${n}.jsonl`, "utf8").trim().split("\n").filter(Boolean) : []; S[n].decisions = log.length;
    let maxRun = 0, run = 0, corrected = 0; for (const l of log) { try { const r = JSON.parse(l); const bad = /refus|invalid_action|busy|blocked|rejected|40\d/.test(JSON.stringify(r.result || r)); run = bad ? run + 1 : 0; maxRun = Math.max(maxRun, run); } catch {} } S[n].maxRefusedRun = maxRun; }
  const P = names.map((n) => S[n].pos).filter(Boolean); let close = 0; for (let i = 0; i < P.length; i++) { let c = 0; for (let j = 0; j < P.length; j++) if (i !== j && dist(P[i], P[j]) <= 6) c++; if (c >= 1) close++; }
  const heardFromBoth = names.map((n) => new Set(S[n].heard.map((h) => h.name)).size);
  const ok = names.every((n) => S[n].ok) && close >= 2 && heardFromBoth.every((k) => k >= 2) && names.every((n) => S[n].maxRefusedRun <= 5);
  result("E16-" + arm, "each agent heard both others; >= 2 of 3 within 6 m of another; no refused run > 5", ok, { S: Object.fromEntries(names.map((n) => [n, { pos: S[n].pos && S[n].pos.map((v) => +v.toFixed(1)), heardNames: [...new Set(S[n].heard.map((h) => h.name))], decisions: S[n].decisions, maxRefusedRun: S[n].maxRefusedRun }])), within6mAgents: close }, arm);
})();
