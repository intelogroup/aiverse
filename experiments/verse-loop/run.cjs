// node run.cjs [E01,E03,...]   (default: all)  — runs experiments one after another, each with a time limit; failures never stop the loop.
const { setExp, result, RUN, OUT } = require("./lib.cjs"); const E = require("./suite.cjs");
const ids = (process.argv[2] || Object.keys(E).join(",")).split(","); const LIMIT = Number(process.env.LOOP_LIMIT_S || 420) * 1000;
(async () => {
  for (const id of ids) { setExp(id); console.log(`\n== ${id} (run ${RUN})`);
    try { await Promise.race([E[id](), new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout after ${LIMIT / 1000}s`)), LIMIT))]); }
    catch (e) { result(id, "(experiment crashed)", false, { error: String(e.message || e).slice(0, 200) }); } }
  console.log("\nRUN_DONE", RUN);
})();
