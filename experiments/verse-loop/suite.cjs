const { Agent, sleep, now, http, dist, log, setExp, result } = require("./lib.cjs");
const spaced = async (labels, opts) => { const out = []; for (const l of labels) { out.push(await new Agent(l).onboard(opts)); await sleep(250); } return out; };
const cleanup = (as) => Promise.all(as.map((a) => a.detach().catch(() => {})));
const goto = async (a, p) => { let r = await a.act({ type: "go_to", point: p }); if (r.status === "blocked") { await sleep(3500); r = await a.act({ type: "go_to", point: p }); } a.lastGoto = r.status; return r; };
// learn a peer's handle the way the guide intends: they speak, you read heard[].from (the same handle observe.scene shows)
const learnHandle = async (speaker, listener) => { const t = `hi-${now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`; await speaker.say(t); await sleep(300); const h = ((await listener.observe())?.heard || []).find((x) => x.text === t); return h?.from; };
// the scene body whose distance is closest to the expected one (handles are per-visit, bodies have no names)
const nearestBody = (obs, d) => (obs?.scene || []).filter((o) => o.kind === "body").sort((x, y) => Math.abs(x.distance - d) - Math.abs(y.distance - d))[0];
const ROW = 10.6; // open plaza row (the spawn is (5.7, 10.6))

const E = {};
E.E01 = async () => {
  const as = await spaced(["a1", "a2", "a3", "a4"]); const steps = [];
  for (const a of as) {
    const o1 = await a.observe(); const d = await a.detach(); const o2 = await a.observe(); const re = await http("POST", "/world/body", a.tok, {}); const o3 = await a.observe();
    steps.push({ attach: a.attach, observed: !!o1?.body, detach: d.s, afterDetach: o2 === null ? "refused" : "still_observes", reattach: re.s, observedAgain: !!o3?.body });
  }
  await cleanup(as);
  const ok = steps.every((s) => s.attach === 201 && s.observed && s.detach >= 200 && s.detach < 300 && s.afterDetach === "refused" && s.reattach === 201 && s.observedAgain);
  return result("E01", "4/4 agents attach/detach/re-attach cleanly", ok, { steps });
};
E.E03 = async () => {
  const [A, B] = await spaced(["s1", "s2"]); const rows = [];
  await goto(A, [-6, ROW]);
  for (const d of [2, 5, 7, 10]) {
    await goto(B, [-6 + d, ROW]); await A.act({ type: "face", point: [-6 + d, ROW] });
    for (let k = 0; k < 3; k++) {
      const text = `t${d}-${k}-${now().toString(36)}`; const pa = await A.pos(), pb = await B.pos(); const real = pa && pb ? dist(pa, pb) : null;
      const before = ((await B.observe())?.heard || []).length; const r = await A.say(text); await sleep(300);
      const heard = ((await B.observe())?.heard || []).some((h) => h.text === text);
      rows.push({ d, real: real && +real.toFixed(1), heard, detail: r.detail, expected: real !== null && real <= 6 }); await sleep(1100);
    }
  }
  await cleanup([A, B]);
  const bad = rows.filter((r) => r.heard !== r.expected);
  return result("E03", "heard iff real distance <= 6 m, 12/12", bad.length === 0, { trials: rows.length, mismatches: bad.length, rows: bad.length ? bad : undefined }, bad.length ? "the 'detail' says how many bodies heard it (the spawn cluster adds bystanders)" : "");
};
E.E04 = async () => { // v2: handles learned by speaking, not guessed from distance (v1 failed: a crowded spawn made the nearest-body guess wrong)
  const [A, B] = await spaced(["c1", "c2"]); const legs = [];
  await goto(A, [-6, ROW]); await goto(B, [-3, ROW]); await A.act({ type: "face", point: [-3, ROW] }); await B.act({ type: "face", point: [-6, ROW] });
  const hB = await learnHandle(B, A); await sleep(1100); const hA = await learnHandle(A, B); await sleep(1100);
  for (let k = 0; k < 3; k++) {
    const t0 = now(); const t1 = `q${k}-${t0.toString(36)}`; await A.say(t1, hB); await sleep(250);
    const gotB = ((await B.observe())?.heard || []).find((h) => h.text === t1); const l1 = now() - t0; await sleep(1100);
    const t2 = `r${k}-${t0.toString(36)}`; const t3 = now(); await B.say(t2, gotB?.from || hA); await sleep(250);
    const gotA = ((await A.observe())?.heard || []).find((h) => h.text === t2); const l2 = now() - t3;
    legs.push({ k, bHeard: !!gotB, bToYou: gotB?.toYou, aHeard: !!gotA, aToYou: gotA?.toYou, ms1: l1, ms2: l2 }); await sleep(1100);
  }
  await cleanup([A, B]);
  const ok = !!hA && !!hB && legs.every((l) => l.bHeard && l.bToYou === true && l.aHeard && l.aToYou === true && l.ms1 < 3000 && l.ms2 < 3000);
  return result("E04", "3/3 addressed round trips (toYou true both ways, each < 3 s)", ok, { handles: [!!hA, !!hB], goto: [A.lastGoto, B.lastGoto], legs }, "v2");
};
E.E05 = async () => { // v3: strict — `doing` must NAME the clip played (v2 passed on a leftover "Talking" from the greeting)
  const [A, B] = await spaced(["g1", "g2"]); const trials = [];
  await goto(A, [-6, ROW]); await goto(B, [-3, ROW]); await B.act({ type: "face", point: [-6, ROW] }); await A.act({ type: "face", point: [-3, ROW] });
  const hA = await learnHandle(A, B); await sleep(6000); // let the greeting's Talking clip end
  for (const clip of ["Waving", "Laughing", "Bow"]) {
    const run = A.act({ type: "play", clip, seconds: 4 }, 20000); const seen = []; const t0 = now();
    while (now() - t0 < 3500) { const e = ((await B.observe())?.scene || []).find((o) => o.kind === "body" && o.id === hA); seen.push(e ? `${e.doing}` : "not_in_scene"); await sleep(300); }
    await run; trials.push({ clip, seen: [...new Set(seen)], named: seen.some((d) => String(d).toLowerCase().includes(clip.toLowerCase().slice(0, 4))) }); await sleep(6000);
  }
  await cleanup([A, B]);
  const ok = !!hA && trials.every((t) => t.named);
  return result("E05", "observer's `doing` names each of the 3 clips played", ok, { handle: !!hA, goto: [A.lastGoto, B.lastGoto], trials }, "v3 strict");
};
E.E06 = async () => { // v2: same task, but records WHY an agent is blocked and lets it do what the platform hint says (wait, retry once)
  const as = await spaced(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]); const STALL = [-17, 15.2]; const t0 = now();
  const first = await Promise.all(as.map((a) => a.act({ type: "go_to", place: "stall-0" }, 150000)));
  const retry = await Promise.all(as.map(async (a, i) => first[i].status === "blocked" ? (await sleep(4000 + i * 300), a.act({ type: "go_to", place: "stall-0" }, 100000)) : null));
  const fin = []; for (const a of as) { const p = await a.pos(); fin.push(p ? +dist(p, STALL).toFixed(1) : null); }
  await cleanup(as);
  const a1 = first.filter((r) => r.status === "arrived").length, a2 = as.filter((_, i) => first[i].status === "arrived" || retry[i]?.status === "arrived").length, near4 = fin.filter((d) => d !== null && d <= 4).length;
  return result("E06", ">= 7/8 arrive at one place within 150 s (v1); v2 adds one retry and records final distance", a2 >= 7,
    { arrivedFirstTry: a1, arrivedAfterRetry: a2, within4m: near4, first: first.map((r) => `${r.status}${r.blockedBy ? "@" + r.blockedBy : ""}`), retry: retry.map((r) => r && r.status), finalDistM: fin, blockedDetails: [...new Set(first.filter((r) => r.status === "blocked").map((r) => String(r.detail).slice(0, 110)))], wallS: Math.round((now() - t0) / 1000) }, "v2");
};
E.E07 = async () => { // v2: scene lists no seats on entry (E07 v1), so the holder is found through observe.body.seatedOn and the others must be refused for THAT id
  const A = await new Agent("k1").onboard(); await sleep(250); const B = await new Agent("k2").onboard(); await sleep(250); const C = await new Agent("k3").onboard();
  const ea = await A.act({ type: "enter", place: "tea" }, 170000); const sa = await A.act({ type: "sit" }, 60000); const seat = (await A.observe())?.body?.seatedOn;
  if (!seat) { await cleanup([A, B, C]); return result("E07", "a seat is held by one body: others refused for its id", false, { enter: ea.status, sit: sa.status }, "A seated but body.seatedOn is empty", ); }
  const [eb, ec] = await Promise.all([B.act({ type: "enter", place: "tea" }, 170000), C.act({ type: "enter", place: "tea" }, 170000)]);
  const rb = await B.act({ type: "sit", sittable: seat }, 60000); const rc = await C.act({ type: "sit", sittable: seat }, 60000);
  const rb2 = await B.act({ type: "sit" }, 60000); const seatB = (await B.observe())?.body?.seatedOn;
  await cleanup([A, B, C]);
  const refused = (r) => r.status === "rejected" || r.status === "blocked" || /occupied/i.test(String(r.detail));
  return result("E07", "seat held by one body: 2 explicit sits on its id refused; a plain sit picks a different seat", refused(rb) && refused(rc) && !!seatB && seatB !== seat,
    { seat, entered: [ea.status, eb.status, ec.status], explicit: [`${rb.status}:${rb.detail}`, `${rc.status}:${rc.detail}`], plainSit: rb2.status, seatB }, "v2");
};
E.E10 = async () => { // v2: agents wait 1 s after a say (E12: the body refuses other actions for ~0.86 s after speaking). 15 agents act at once: how long does an instant action take to settle? (social15 saw a 60 s floor in production)
  const N = 15; const as = await spaced(Array.from({ length: N }, (_, i) => "p" + i)); const lat = [], errs = { refused: 0, other: 0 }, hist = {}; const t0 = now();
  await Promise.all(as.map(async (a, i) => { for (let k = 0; k < 16; k++) { const h = (i * 37 + k * 53) % 360; const r = k % 4 === 3 ? await a.say(`l${i}-${k}`) : await a.act({ type: "face", headingDeg: h }, 60000);
    { const key = `${r.status}${r.detail ? ":" + String(r.detail).slice(0, 50) : ""}`; hist[key] = (hist[key] || 0) + 1; } if (/^submit_/.test(String(r.status))) errs.refused++; else if (r.status !== "done") errs.other++; else lat.push(r.ms); await sleep(k % 4 === 3 ? 1000 : 500); } }));
  await cleanup(as); lat.sort((x, y) => x - y); const q = (p) => lat[Math.min(lat.length - 1, Math.floor(p * lat.length))];
  return result("E10", "15 agents x 16 instant acts: p95 < 2 s, no refusals/5xx", lat.length > 200 && q(0.95) < 2000 && errs.refused === 0 && errs.other === 0, { acts: lat.length, p50: q(0.5), p95: q(0.95), p99: q(0.99), max: lat[lat.length - 1], errs, statuses: hist, wallS: Math.round((now() - t0) / 1000) });
};
E.E08 = async () => {
  const as = await spaced(["x1", "x2", "x3", "y1", "y2", "y3"]); const G1 = as.slice(0, 3), G2 = as.slice(3);
  await Promise.all([...G1.map((a, i) => goto(a, [-12 + i * 1.2, ROW])), ...G2.map((a, i) => goto(a, [10 + i * 1.2, ROW]))]);
  const tok = (g, i) => `${g}${i}-${now().toString(36)}`; const sent = {};
  await Promise.all(as.map((a, i) => { const t = tok(i < 3 ? "G1" : "G2", i); sent[a.label] = t; return a.say(t); })); await sleep(500);
  const rows = [];
  for (const [i, a] of as.entries()) { const heard = ((await a.observe())?.heard || []).map((h) => h.text); const mine = i < 3 ? "G1" : "G2"; const other = mine === "G1" ? "G2" : "G1";
    rows.push({ who: a.label, own: heard.filter((t) => t.startsWith(mine)).length, cross: heard.filter((t) => t.startsWith(other)).length }); }
  await cleanup(as);
  const ok = rows.every((r) => r.cross === 0 && r.own === 2); // each hears the 2 other speakers of its own group (not itself)
  return result("E08", "each of 6 listeners hears its 2 group mates and 0 cross-group lines", ok, { rows });
};
E.E09 = async () => {
  const [A] = await spaced(["z1"]); const r = {};
  const id = `idem${now().toString(36)}`; const act = { type: "face", headingDeg: 45 };
  const s1 = await http("POST", "/world/act", A.tok, { id, action: act }); const s2 = await http("POST", "/world/act", A.tok, { id, action: act }); const s3 = await http("POST", "/world/act", A.tok, { id, action: { type: "face", headingDeg: 90 } });
  r.replay = [s1.s, s2.s]; r.reusedIdDifferent = s3.s;
  const bad = await http("POST", "/world/act", A.tok, { id: `bad${now().toString(36)}`, action: { type: "teleport", x: 1 } }); r.invalid = [bad.s, bad.j.error, String(bad.j.message || "").slice(0, 80)];
  const naked = await new Agent("nv").onboard({ body: false }); const reg = await http("POST", "/agents/register", null, { name: `nv${Math.random().toString(36).slice(2, 6)}`, capabilities: ["explore"], description: "no claim" }); const nb = await http("POST", "/world/body", reg.j.agentToken, {}); r.unclaimedAttach = nb.s;
  await cleanup([A]);
  const ok = r.replay[0] === 202 && (r.replay[1] === 202 || r.replay[1] === 200) && r.reusedIdDifferent >= 400 && bad.s === 400 && /valid|type/.test(String(bad.j.message || bad.j.error || "")) && r.unclaimedAttach >= 400;
  return result("E09", "replay idempotent, reused id refused, invalid 400 with options, unclaimed agent refused", ok, r);
};
module.exports = E;
E.E11 = async () => { // one agent, back-to-back instant acts: how long after a `face` settles is the body still "busy"? (found by E10: 56% rejected busy at 500 ms spacing)
  const A = await new Agent("b1").onboard(); const rows = [];
  for (const gap of [0, 250, 500, 1000, 1500, 2500]) { let busy = 0, done = 0; for (let k = 0; k < 6; k++) { const r = await A.act({ type: "face", headingDeg: (k * 61 + gap) % 360 }, 30000); if (r.status === "rejected") busy++; else if (r.status === "done") done++; await sleep(gap); } rows.push({ gapMs: gap, done, busy }); }
  // the same with say/wait mixed in
  const kinds = {}; for (const [name, act] of [["wait0.2", { type: "wait", seconds: 0.2 }], ["say", { type: "say", text: "x" }], ["gaze", { type: "gaze", yawDeg: 20 }]]) { let busy = 0, n = 0; for (let k = 0; k < 5; k++) { const r = await A.act(act, 30000); n++; if (r.status === "rejected") busy++; await sleep(600); } kinds[name] = `${busy}/${n} busy at 600 ms spacing`; }
  await cleanup([A]);
  const ok = rows.find((r) => r.gapMs === 500).busy === 0; // the documented budget is ~2 acts/s per agent
  return result("E11", "back-to-back face acts at 500 ms spacing are never rejected busy (documented ~2 acts/s)", ok, { rows, kinds });
};
E.E12 = async () => { // after `say`, how long is the body refused other actions? (E10/E11: gaze/face right after a say answered rejected busy)
  const A = await new Agent("w1").onboard(); const rows = [];
  for (const [label, act] of [["face", { type: "face", headingDeg: 30 }], ["gaze", { type: "gaze", yawDeg: 15 }], ["go_to near", { type: "go_to", point: [6.5, 10.6] }], ["play Waving", { type: "play", clip: "Waving", seconds: 2 }]]) {
    for (let k = 0; k < 2; k++) { await A.say(`hi ${label} ${k}`); const t0 = now(); let first = null, tries = 0;
      while (now() - t0 < 12000) { tries++; const r = await A.act(act, 20000); if (r.status !== "rejected") { first = { ms: now() - t0, status: r.status }; break; } await sleep(200); }
      rows.push({ after: "say", then: label, acceptedAfterMs: first ? first.ms : ">12000", tries }); await sleep(2500); } }
  await cleanup([A]);
  const worst = Math.max(...rows.map((r) => (typeof r.acceptedAfterMs === "number" ? r.acceptedAfterMs : 12000)));
  return result("E12", "an action issued right after `say` is accepted within 1 s", worst <= 1000, { worstMs: worst, rows });
};
