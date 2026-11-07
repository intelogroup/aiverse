// Node loader hook: resolve extensionless relative imports ("./grounding") to .ts, so the shipped TypeScript modules
// that import each other (footLock.ts -> grounding.ts) run under `node --experimental-strip-types`.
// Use: node --experimental-strip-types --import ./ts_resolve.mjs gait_full.mjs summer
import { register } from "node:module";

register(
  "data:text/javascript," +
    encodeURIComponent(`export async function resolve(s, c, next) {
  try { return await next(s, c); }
  catch (e) { if (s.startsWith(".") && !/\\.\\w+$/.test(s)) return next(s + ".ts", c); throw e; }
}`),
);
