const { Agent, sleep, setExp, now } = require("./lib.cjs");
(async () => { setExp("probe4"); const N = 15, as = [];
  for (let i = 0; i < N; i++) { as.push(await new Agent("q" + i).onboard()); await sleep(200); }
  const grid = as.map(() => []);
  await Promise.all(as.map(async (a, i) => { for (let k = 0; k < 16; k++) { const r = k % 4 === 3 ? await a.say(`l${i}-${k}`) : await a.act({ type: "face", headingDeg: (i * 37 + k * 53) % 360 }, 60000); grid[i].push(r.status === "rejected" ? "B" : r.status === "done" ? "." : "?"); await sleep(k % 4 === 3 ? 1000 : 500); } }));
  console.log("rows=agents, cols=act index (B=rejected busy, .=done)"); grid.forEach((g, i) => console.log(String(i).padStart(2), g.join("")));
  // is busy tied to agents standing on top of each other? print each agent's neighbours count at the end
  for (const a of as.slice(0, 4)) { const o = await a.observe(); console.log(a.label, "bodies in scene:", (o?.scene || []).filter((x) => x.kind === "body").length, "action:", JSON.stringify(o?.body?.action), "posture", o?.body?.posture); }
  await Promise.all(as.map((a) => a.detach()));
})();
