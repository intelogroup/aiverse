// probe5: path of go_to / enter shop-102 from the plaza: sampled pose every 3 s; path length vs straight line. LOCAL only.
const { Agent, sleep, setExp } = require("./lib.cjs"); const kind = process.argv[2] || "go_to";
(async () => { setExp("probe5"); const a = await new Agent("p5" + kind.replace(/\W/g, "")).onboard(); const p0 = await a.pos();
  const id = "p5" + Date.now().toString(36); const { http } = require("./lib.cjs");
  const act = kind === "enter" ? { type: "enter", place: "shop-102" } : { type: "go_to", place: "shop-102" };
  const t0 = Date.now(); const sub = await fetch("http://127.0.0.1:3010/world/act", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + a.tok }, body: JSON.stringify({ id, action: act }) }); console.log("submit", sub.status);
  let path = [p0], len = 0, st = "?";
  while (Date.now() - t0 < 240000) { await sleep(3000); const p = await a.pos(); if (p) { len += Math.hypot(p[0] - path.at(-1)[0], p[1] - path.at(-1)[1]); path.push(p); }
    const g = await (await fetch(`http://127.0.0.1:3010/world/act/${id}`, { headers: { authorization: "Bearer " + a.tok } })).json(); st = g.act?.outcome?.status || g.act?.state; if (g.act?.state === "settled") { console.log("settled", JSON.stringify(g.act.outcome)); break; } }
  const end = path.at(-1); console.log(kind, "start", p0.map((v) => +v.toFixed(1)), "end", end.map((v) => +v.toFixed(1)), "straight m", +Math.hypot(end[0] - p0[0], end[1] - p0[1]).toFixed(1), "walked m", +len.toFixed(1), "secs", Math.round((Date.now() - t0) / 1000), "state", st);
  console.log("path", path.filter((_, i) => i % 3 === 0).map((q) => q.map((v) => Math.round(v)).join(",")).join(" "));
})();
