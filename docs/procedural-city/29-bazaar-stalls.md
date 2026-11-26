# 29 — The bazaar stalls

The plaza is the largest open space in City 3 and the only one whose furniture you
walk *through* rather than past. It had one stall: `LIB_sk_med_stall`, a 600-triangle
mesh instanced 80 times. Every counter was empty, every stall identical, and the nodes
carried a non-uniform scale of (1.4, 1.2, 1.4) that stretched the source mesh 15%
above its authored height.

This page records what the audit found, what was replaced, and the two measurement
traps that between them nearly produced a wrong diagnosis and a shipped regression.

![Bazaar stalls before and after](previews/29-bazaar-stalls.png)

## What the audit measures

`stall_audit.py` (gate 7 in `world_gate.py`) reports:

| finding | meaning |
|---|---|
| `thrifty_stalls` | every stall is the same mesh: no variety in the largest open space |
| `bench_overlap` | a bench or crate standing inside the stall counter |
| `lantern_through_roof` | a hanging lantern whose body rises above the stall roof |

Before: `thrifty_stalls 1`, `bench_overlap 8`. After: `bench_overlap 8` only — those
eight are pre-existing and pinned, because bench positions come from `build_city.py`'s
baked `BENCHES` list and the generator cannot run on this box.

## Trap 1: the broken stalls that did not exist

The first audit reported **59 of 80 positions carrying leftover procedural frames plus
a floating awning sheet at y = 3.50** — a plausible story: `bridge_bazaar.promote_stalls`
only deletes the procedural counter at the positions it promotes on *its* run, so
earlier-promoted positions would keep theirs.

The numbers were real; the conclusion was wrong. Those triangles were already
**degenerate**: `bridge_bazaar.degenerate_inside` has collapsed killed triangles onto a
single vertex since the bazaar pass, so 3,720 `palette` and 118 `awning` triangles sat
in the file with **zero area** and rendered nothing. Counting triangles by midpoint made
them look like geometry. This is the same trap as the 872 "0-triangle" nodes that turned
out to be unindexed 2-tri panels: **a triangle existing is not evidence it is visible —
check its area.**

Both the audit and the bridge now filter `area > 1e-9`, and the bridge reports those
boxes as `dead_at_boxes`, separate from anything it actually removed.

## Trap 2: the replacement lowered the roofs into the lanterns

136 `SK_lantern` nodes hang over the stalls with their tops at y = 2.82. The shipped
stall roof was at **2.957**, so the lanterns cleared it by 0.137 m.

The first rebuild fitted the new stalls to 2.45 m — the natural height of the source
scan — which put the roof at 2.65 and drove **0.17 m of lantern through it** at all 136
fixtures. Nothing looked wrong on the isolated renders. The map now sets 2.72 m
(variant A) and 2.66 m (variant B), roofs at 2.92 and 2.86, and `lantern_through_roof`
exists so the next person cannot ship this quietly.

## What was replaced

Two stalls from the Sketchfab *Medieval Market Stall Asset* set by Uğur Yakışık
(CC-BY 4.0, credited in `tools/city3/ASSETS.md` and `out/asset-credits.json`):

| variant | source | tris (scan → built) | footprint | instances |
|---|---|---|---|---|
| A — cloth canopy, produce trays | Model 1/4 | 4,072 → 2,599 | 3.00 × 1.53 m | 36 |
| B — wooden counter, pottery | 4/4 | 2,770 → 1,700 | 2.78 × 1.49 m | 44 |

Both fit inside the shipped envelope (3.12 × 1.64), so no aisle narrowed. A carries
tomatoes and potatoes in trays, B carries a bowl, potatoes and cups, so no counter is
bare. Variants alternate on a 9 m parity so neighbours never match.

World triangles: 80 × 600 = 48,000 → 36 × 2,599 + 44 × 1,700 = **168,364** (+120k,
+4.5% of the 2.65M-triangle world). File: 59.33 → 60.01 MB.

## How it is built and applied

```bash
# 1. fetch (registry of every source, and which ones a script may fetch)
python3 tools/city3/sources.py list
python3 tools/city3/sources.py find "market stall"
python3 tools/city3/sources.py get sketchfab:stall1of4=<uid>

# 2. scan -> two normalised GLBs (drops the baked 6 m ground plane and the normal and
#    roughness maps, decimates, uniform-scales to height, origin at bottom centre)
blender -b --factory-startup --python tools/city3/stall_assets.py -- --tex 256

# 3. append into the world and repoint the 80 nodes (raw GLB, no re-export)
python3 tools/city3/bridge_stalls.py

# 4. prove it
python3 tools/city3/stall_audit.py --check
python3 tools/city3/world_gate.py --uv
```

`bridge_stalls.py` appends the two meshes, materials and textures into the world file by
index-shifting (the `replace_glb_detail.py` contract), repoints the existing stall nodes,
sets their scale to 1, and leaves the old mesh as dead weight — the same policy as every
other bridge here. It never re-exports the world.

### The meshopt trap inside step 3

`rewrite_indices()` from `bridge_bazaar.py` **always** writes an
`EXT_meshopt_compression` block. The stall meshes' index accessors are 32-bit *plain*
views, so stamping that extension produced a GLB Blender refused to open:

```
KeyError: 'buffer'  (io_scene_gltf2/io/imp/gltf2_io_binary_meshopt.py:84)
```

`set_indices()` now branches: compressed views go through `rewrite_indices`, plain views
are overwritten in place (same count, same size, no extension). Any future bridge that
deletes triangles should use it instead of calling `rewrite_indices` directly.

## Verification

- `stall_audit.py --check` → only the 8 pinned bench overlaps
- `world_gate.py --uv` → **7/7 gates**, 4.6 s
- both variants have 0 unmapped triangles (`uv_stats.py`)
- roof/lantern clearance 0.10 m (A) and 0.04 m (B), measured, not assumed
- 59.33 → 60.01 MB; 80 nodes repointed, none added or dropped

## Left open

- **The 8 bench overlaps.** Half a bench sits inside the counter at eight positions
  (overlap 1.04 × 0.54 m). Identical on the pre-edit GLB, so this work did not introduce
  it; fixing it means changing the generator's `BENCHES` list.
- **Textures are unverified in a browser.** Everything above is Workbench or numeric.
  The stalls use 256 px PNG/JPEG base colour while the rest of the world is KTX2, so the
  Vercel preview is where that reads correctly or not.
- The old 600-tri mesh, its accessors and the palette textures remain in the file.

