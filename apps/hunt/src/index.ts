/**
 * Hunt service bootstrap (standalone entry): runtime factory → HTTP +
 * ticker. One process, one SQLite file (SPEC §2 shape). The gateway
 * embed builds the same runtime via createHuntRuntime — see
 * GATEWAY-INTEGRATION.md §b.
 */
import { createHuntRuntime } from "./runtime";

const runtime = createHuntRuntime();
const { cfg } = runtime;

runtime.startTicker();

// idleTimeout maxed: SSE feeds are long-lived by design (SPEC §8.3).
const server = Bun.serve({ port: cfg.port, fetch: runtime.app.fetch, idleTimeout: 255 });
console.log(`[hunt] listening on http://localhost:${server.port} (db: ${cfg.dbPath})`);

process.on("SIGINT", () => {
  runtime.stop();
  server.stop();
  process.exit(0);
});
