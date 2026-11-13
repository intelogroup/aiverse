#!/usr/bin/env bun
// Turn split_world output (visual tiles + collision tiles) into a district manifest the console can stream.
//   bun tools/city3/tiles_manifest.mjs <assets dir>   (reads <dir>/districts.json for themes/links/shell, tiles/tiles.json, tiles/col/tiles.json)
// Every tile is a DistrictDef: centre/half give the streaming rect, `origin` [0,0] says the GLB is already in world coordinates.
import { readFileSync, writeFileSync, copyFileSync, readdirSync } from "node:fs";
const A = process.argv[2] ?? "apps/console/public/assets";
const base = JSON.parse(readFileSync(`${A}/districts.json`, "utf8"));
const vis = JSON.parse(readFileSync(`${A}/tiles/tiles.json`, "utf8"));
const col = JSON.parse(readFileSync(`${A}/tiles/col/tiles.json`, "utf8"));
const colById = new Map(col.tiles.map(t => [t.id, t]));
const visIds = new Set(vis.tiles.map(t => t.id));
// A square can hold collision but no visual triangle (open plaza ground is a few wide quads). Such a tile has url "": the runtime loads only its collision.
const orphan = col.tiles.filter(t => !visIds.has(t.id));
const theme = base.districts[0].theme;
// The core is the critical path and must be requestable before the manifest (with its content-hashed names) is read, so the page
// can preload it: it also ships under stable names. Those two files revalidate (no-cache); everything else is immutable.
const core = vis.tiles.find(t => t.core);
copyFileSync(`${A}/tiles/${core.url}`, `${A}/tiles/core.glb`);
if (colById.has(core.id)) copyFileSync(`${A}/tiles/col/${colById.get(core.id).url}`, `${A}/tiles/core.col.glb`);
const districts = [...vis.tiles, ...orphan.map(t => ({ ...t, url: "" }))].map(t => ({
  id: t.id, name: t.core ? "Bazaar core" : t.id, url: t.core ? "/assets/tiles/core.glb" : t.url ? `/assets/tiles/${t.url}` : "",
  ...(colById.has(t.id) ? { collisionUrl: t.core ? "/assets/tiles/core.col.glb" : `/assets/tiles/col/${colById.get(t.id).url}` } : {}),
  center: t.center, half: t.half, origin: [0, 0], theme, ...(t.core ? { resident: true } : {}), tris: t.tris,
}));
const shell = readdirSync(`${A}/tiles`).find(f => /^shell\.[0-9a-f]+\.glb$/.test(f)); // split_shell.mjs output: shell_bazaar cut into shell_<tileId> nodes
if (!shell) throw new Error("no tiles/shell.*.glb: run split_shell.mjs first");
const out = { ...base, shell: `/assets/tiles/${shell}`, districts, tiles: true, streaming: { loadRadius: 40, keepRadius: 110, maxStreamed: 48, evictGraceMs: 20000, maxConcurrent: 4 } };
writeFileSync(`${A}/tiles/districts.json`, JSON.stringify(out));
console.log(`${districts.length} tiles (${orphan.length} collision-only), ${districts.filter(d => d.collisionUrl).length} with collision; core ${districts.find(d => d.resident)?.id}`);
