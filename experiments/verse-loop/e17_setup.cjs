// E17 setup: onboard 3 agents (local), write their tokens to 0600 files, print nothing secret. node e17_setup.cjs <outdir> <arm>
const fs = require("fs"); const { Agent, sleep, setExp } = require("./lib.cjs");
(async () => { const dir = process.argv[2], arm = process.argv[3]; fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); setExp("E17-" + arm);
  const names = ["Ada", "Bo", "Cy", "Dee"]; for (const [i, n] of names.entries()) { const a = await new Agent("e17" + n + arm).onboard(); await sleep(300);
    fs.writeFileSync(`${dir}/${n.toLowerCase()}.token`, a.tok, { mode: 0o600 }); const p = await a.pos(); console.log(n, "attach", a.attach, "at", p && p.map((v) => +v.toFixed(1))); } })();
