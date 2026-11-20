// spz.mjs — optional SPZ comparison for the splat trial.
// Tries Spark's transcodeSpz in Node: PLY -> SPZ, report bytes and
// round-trip splat count. If Spark's WASM plumbing refuses to run
// outside a browser, this prints the failure and exits 3 — the trial
// record then states SPZ was not testable in this environment.
// Usage: node spz.mjs [plyPath]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const plyPath = process.argv[2] || path.join(HERE, "bazaar-stall-262k.ply");

try {
  const spark = await import("@sparkjsdev/spark");
  const bytes = fs.readFileSync(plyPath);
  console.log("input PLY bytes:", bytes.length);
  const t0 = Date.now();
  const out = await spark.transcodeSpz({
    inputs: [{ fileBytes: new Uint8Array(bytes), pathOrUrl: path.basename(plyPath) }],
  }).catch((e) => ({ error: String(e).slice(0, 300) }));
  if (out.error) {
    console.log("transcodeSpz failed:", out.error);
    process.exit(3);
  }
  const spzBytes = out.fileBytes;
  console.log("SPZ bytes:", spzBytes.length, "in", Date.now() - t0, "ms");
  const outPath = path.join(HERE, "bazaar-stall-262k.spz");
  fs.writeFileSync(outPath, spzBytes);
  console.log("wrote", outPath);
} catch (e) {
  console.log("spz probe failed:", String(e).slice(0, 300));
  process.exit(3);
}
