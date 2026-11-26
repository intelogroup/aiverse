# Third-party assets (City 3 interiors)

The base interior assets in the first table are **CC0** (public domain dedication). No attribution is required; we credit the authors anyway. Later sections record other assets with their individual licence status.
They are not committed: `assets/fetch.sh` downloads them, and the build decimates them and resizes their
textures to 512 px before export into `world-city3-press.glb`.

## Uploaded drinking glasses and workshop sources

The user's Verres FBX/OBJ set supplies the wine, water and champagne shapes now used for Bazaar/café goblets. Geometry and physical glass material are committed in `assets/verres/drinkware.glb`; source references, checksums and unknown author/licence fields are in `assets/verres/source-manifest.json`. This upload is not declared CC0. See `docs/procedural-city/17-drinking-glasses.md` for regeneration and browser checks.

Native workshop assets are retained outside public assets: `assets/source_bottles/Wine+Bottles+Pack.blend` and `assets/unity/free_dissolve_shader_pack_urp.unitypackage`. Their inventories, compatibility and source status are recorded in `assets/wine_bottles_pack.json` and `assets/dissolve_shader_pack.json`. These packs have not been placed in the live world.

## Base interior imports

**SciFi EasterEgg** — Cécile Amstad, [Sketchfab source](https://sketchfab.com/3d-models/scifi-easteregg-f19c4de512794d64b00b3f5ceea62ca2), [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). User-supplied archive and exact license in `assets/scifi_easteregg/`; 10k-triangle derivative and 30-placement manifest in console `public/assets/collectibles/`. Modified by joining/welding/simplifying and normalizing scale; original vertex colors retained. Public attribution is linked from the verse. See `docs/procedural-city/19-easter-eggs.md`.

Fruit/vase replacements: `assets/market_realism/manifest.json` records the approved 26-template kit and the Poly Haven CC0 apple/lemon sources. Geometry and embedded PBR maps are committed in `assets/market_realism/fruit-vases.glb`. See `docs/procedural-city/18-fruit-vases.md` for generator/bridge details.

The central upload register is `assets/user_uploads.json`; `assets/external_candidates.json` keeps linked candidates separate. Each record states inspection, licence, archive and placement status; registered upload references are not automatically shipped assets.

| Asset | Author(s) | License | Source |
|---|---|---|---|
| Wooden Crate 01 | James Ray Cock | CC0 | https://polyhaven.com/a/wooden_crate_01 |
| ChairCushioned | Quaternius | CC0 | https://opengameart.org/content/furniture-low-poly |
| Desk Lamp Arm 01 | Yann Kervran, Kuutti Siitonen | CC0 | https://polyhaven.com/a/desk_lamp_arm_01 |
| Binder Notebook | DaDrood | CC0 | https://polyhaven.com/a/binder_notebook |
| Vintage Radio Transceiver | Mateusz Sadek | CC0 | https://polyhaven.com/a/vintage_radio_transceiver |
| Book Encyclopedia Set 01 | John Malcolm | CC0 | https://polyhaven.com/a/book_encyclopedia_set_01 |
| Wooden Bookshelf Worn | Ulan Cabanilla | CC0 | https://polyhaven.com/a/wooden_bookshelf_worn |
| Drawer Cabinet | Ulan Cabanilla | CC0 | https://polyhaven.com/a/drawer_cabinet |
| Vintage Grandfather Clock 01 | Yann Kervran, James Ray Cock | CC0 | https://polyhaven.com/a/vintage_grandfather_clock_01 |
| Wall Clock | PierreB3D | CC0 | https://polyhaven.com/a/wall_clock |
| Arm Chair 01 | Kirill Sannikov | CC0 | https://polyhaven.com/a/ArmChair_01 |
| Wooden Table 02 | Fran Calvente | CC0 | https://polyhaven.com/a/WoodenTable_02 |
| Vintage Oil Lamp | Monsta3D | CC0 | https://polyhaven.com/a/vintage_oil_lamp |
| Potted Plant 02 | Rico Cilliers | CC0 | https://polyhaven.com/a/potted_plant_02 |

## Townhouses (citadel block rebuild, world-city3.glb)

Ten Lost Gecko street-front buildings on Sketchfab, CC-BY 4.0, vendored in `assets/townhouses/<slug>/` (geometry plus the diffuse texture only; the normal and
specular maps are dropped, `manifest.json` lists them). They replace the eight hollow citadel boxes (shop-148..155).

| Asset | Author | Licence | Source |
|---|---|---|---|
| Bordeaux Flat 1 corner [France] | Lost Gecko | CC-BY 4.0 | https://sketchfab.com/3d-models/cde0ef76b4ab482bad79d29fe5fb7a88 |
| Nivelles House 9 [Belgium] | Lost Gecko | CC-BY 4.0 | https://sketchfab.com/3d-models/9a6bbcb6da704592b368e29b87cac11d |
| Angers Shop 2 [France] | Lost Gecko | CC-BY 4.0 | https://sketchfab.com/3d-models/bbed1d3fdae3493b8f1872c9a9e7e8d4 |
| Troyes Shop 7 [France] | Lost Gecko | CC-BY 4.0 | https://sketchfab.com/3d-models/8fb84880b9234a8a8cbc8b92b46e38a6 |
| Cork Corner Shop 1 [Ireland] | Lost Gecko | CC-BY 4.0 | https://sketchfab.com/3d-models/21818eaa4c1c402a82baf9031ebaa93a |
| Mons Shop 2 [Belgium] | Lost Gecko | CC-BY 4.0 | https://sketchfab.com/3d-models/7397096856d3452fa15ae074f460ad36 |
| Nivelles House 1 [Belgium] | Lost Gecko | CC-BY 4.0 | https://sketchfab.com/3d-models/592cc5891ef34ab98abdeaa8b9b1fba8 |
| Angers Shop 1 [France] | Lost Gecko | CC-BY 4.0 | https://sketchfab.com/3d-models/ec891e10fe26403aa072173bb89861bb |
| Nivelles House 2 [Belgium] | Lost Gecko | CC-BY 4.0 | https://sketchfab.com/3d-models/65523e6f1e3c46d9930aa727a457cf0f |
| Guingamp Shop 1 [France] | Lost Gecko | CC-BY 4.0 | https://sketchfab.com/3d-models/8bf9f75a6aeb4b77b195cbc55f21edb8 |
| Troyes Market Hall [France] (the civic hall, `Kit_hall0`) | Lost Gecko | CC-BY 4.0 | https://sketchfab.com/3d-models/704dee7fa5e54cbc88de174ea1272b60 |
| Gazebo (the garden block centre, `Kit_garden0`) | ZareShadows | CC-BY 4.0 | https://sketchfab.com/3d-models/ab95dfb3816e4160989f26972c4c7c39 |
| Rose Arch (four garden entrances, `Kit_garden1-4`; titled CC0 on the page, its licence file says CC-BY 4.0, so credited) | plaggy | CC-BY 4.0 | https://sketchfab.com/3d-models/5578bdc83ed743feb5f7c775197f5fbe |

## Halo Lagoon (world-halo.glb)

| Asset | Author | Licence | Source |
|---|---|---|---|
| Outdoor Table Chair Set 01 | James Ray Cock | CC0 | https://polyhaven.com/a/outdoor_table_chair_set_01 |
| Coffee Cart 01 | Joe Seabuhr | CC0 | https://polyhaven.com/a/CoffeeCart_01 |
| Planter Box 01 | James Ray Cock | CC0 | https://polyhaven.com/a/planter_box_01 |
| Bronze Whale Statue | Tina | CC0 | https://polyhaven.com/a/bronze_whale_statue |
| Bronze Ray Statue | Tina | CC0 | https://polyhaven.com/a/bronze_ray_statue |
| Bronze Shark Statue | Tina | CC0 | https://polyhaven.com/a/bronze_shark_statue |
| Lifebuoy | Hank Kaamura | CC0 | https://polyhaven.com/a/lifebuoy |
| Palm Tree Bark (texture) | Dimitrios Savva, Rico Cilliers | CC0 | https://polyhaven.com/a/palm_tree_bark |
| Palm frond diffuse + alpha (PalmFrondDiffuse/Alpha.png), recoloured into tex_m/halo_foliage.png | SSimpossible | CC0 (uploader-declared) | https://blendswap.com/blend/5812 |

Flower tiles in halo_foliage.png, cars, yachts, parasols, kiosks, bins: procedural (halo_tex.py, halo_props.py).

Not used, on purpose:
- **BlenderKit** "Royalty Free" assets: its licensing FAQ says assets in a distributed game "shouldn't be directly extractable"; a web GLB is extractable. Its CC0 assets would be fine but need a signed-in add-on.
- **Synty POLYGON**: paid EULA, no clear answer on shipping raw models in a browser build.
- **Kenney**: CC0, but kenney.nl and its GitHub return 403 from this build environment.

## Bazaar stall goods (world-city3.glb, `goods.py` + `goods_stock.py`)

| Asset | Source | Licence | Use |
|---|---|---|---|
| Basket (2180 -> 240 tris), Grain Sack (938 -> 320), Sack (1529 -> 340), Roll (190), Cheese Wheel (1270 -> 260), Barrel (2348 -> 320) | Sketchfab "Low Poly Medieval, CC0" pack by Avramania (uids aef0f7e9, 7db2a145, 3deb43fe, 9cd0c6d3, c66175e5, 72b75758), fetched with `fetch_sketchfab.py` into `assets/sketchfab/g_*` (gitignored) | CC0 | baskets (with procedural fruit / bread heaps), sacks of grain, bread rolls, cheese, wine barrels |
| Pot (680 -> 320), Lantern (338 -> 170) | same pack, already local (`assets/sketchfab/pot`, `lantern`) | CC0 | pottery stalls, lamp stalls and hung lanterns |
| Wooden Bucket 01 (5116 -> 300), Metal Jug (6040 -> 300) | Poly Haven (`wooden_bucket_01`, `metal_jug`) via `assets/fetch_polyhaven.py` | CC0 | dairy / basket stalls |
| 61 procedural pieces (fruit and veg crates, fruit heaps, pyramids, spice trays, bolts and rolls of cloth, folded cloth, drapes, pots, bowls, plates, bottles, goblets, ewers, loaves, baguettes, cheese wedges, hanging chilli / garlic / onion / pepper / herb strings) | `goods.py`, palette material, no texture | n/a | everything with real colour variation (icosphere fruit, 20 tris each) |

`g_fruitbasket` (Fruit Basket, 3646 tris, uid 736ae73e) is fetched but unused (the procedural heaps in a real basket read better and cost less).
Every piece is a linked duplicate under an `inst_goods_<key>` Empty (GPU instancing). Stock per stall = `goods_stock.stock_of(i)` (11 stocks, `random.Random(5150+i)`),
layout = `goods_stock.layout(i, med)` (`random.Random(6100+i)`); neither touches the city rng. Run `python3 -I goods_report.py out.json` to list stall -> stock.

## Bazaar party corner (world-city3.glb)

| Asset | Source | Licence |
|---|---|---|
| partyTable, partyCup{Red,Blue,Green,Yellow,Pink}_{full,stack,shortStack,used} (USDZ) | uploaded by the project owner (`partycups_usdz.zip`), kept local in `assets/partycups/` (gitignored) | not stated in the upload; confirm before redistributing |

Imported with `assets_kit.load(..., source="usdz")`: cups decimated to 240–380 tris, table to 900, base-colour texture only (128/256 px), GPU-instanced under the `PartyCups` Empty.

## District trees (blob-tree replacement, branch tmp/kaykit-trees — NOT shipped)

The district-tree source on this branch (Bazaar via `build_city.py`, the modern districts via `mdetails.py`):

| Asset | Author | Licence | Source |
|---|---|---|---|
| Low Poly Forest Tree Pack (3,752 faces, whole pack) | 99.Miles | CC-BY 4.0 | https://sketchfab.com/3d-models/low-poly-forest-tree-pack-5ff5a51e74324845a4e4905f182dfb2b |

Downloaded with the owner's Sketchfab account (the connector download route returned 401; the files arrived by a one-off authenticated download). Extracted zip kept local in `assets/sketchfab/low-poly-forest-tree-pack/` (gitignored, like the blendkit downloads): `scene.gltf` + `scene.bin` + `textures/` + the pack's own `license.txt` (CC-BY 4.0, author 99.Miles). Attribution rides in the build's `asset-credits.json` via the LIB entries' credit fields.

Loaded by `assets_kit.tree_variants_sketchfab`: trunk/branch part pairs are joined into whole trees — `hero_full` (624 tris), `hero_tall` (630), `hero_stocky` (624), `hero_birch` (285; grey trunk, golden autumn crown) — plus the pack's atlas-card background trees (`bg_*`, registered but currently unused: they read as painted cards up close). No decimation (the heroes are already at budget) and NO palette re-skin: the pack ships with its own atlas textures, downsized to the 512 px pipeline budget, diffuse-only; study frames showed a flat re-skin collapses its branch cards into slabs while the textured original reads as a proper low-poly tree. Foliage keeps alpha cutout (source alphaMode BLEND → Math ROUND on alpha in the material → glTF alphaMode MASK, the halo-palm pattern). The pack's rocks and shrubs are not used. Placement weights mirror the old blob build's three-variant mix, with the birch in the accent slot.

## District ground — Bazaar plaza (branch tmp/city3-ground, stacked on tmp/kaykit-trees)

The Bazaar's `PlazaCobble` surface (the 120×120 m market square), re-paved in the texture pass (owner's pick "B" of three proofed finalists):

| Asset | Author | Licence | Source |
|---|---|---|---|
| PavingStones150 (1K JPG set: Color / NormalGL / Roughness / AmbientOcclusion / Displacement) | ambientCG | CC0 | https://ambientcg.com/view?id=PavingStones150 |

Downloaded from ambientCG's public API (no key needed). The 1K JPG set is kept local in `assets/ambientcg/PavingStones150/` (gitignored, like the other downloads); `mtex.py:acg_pbr` converts it into the pipeline's `tex_m/` layout as `plaza_setts` — diffuse with the set's AO multiplied in (ambientCG's own template does the same), NormalGL as the normal map, and a channel-packed companion texture in glTF metallicRoughness layout (R = AO, G = roughness, B = 0 metalness) that `pbr_override` wires when present, so roughness ships as a real texture map. Displacement is not used. Applied by `build_city.py`'s PBR override on the `cobble` material only, planar world UVs, one texture repeat = **2.5 m**, no tint — the fan-sett paving proofed in the selection rig. It replaces the Poly Haven `herringbone_concrete_tile` (`plaza_stone`) on this surface only; `plaza_stone` still serves Halo's `stone` material, and no other district's ground changes in this pass (survey in the build record: Terraces = sidewalk-class herringbone block fill + grass gardens + terrazzo decks; Glass Quarter plaza = its own terrazzo treatment, block fill is sidewalk class; Foundry = concrete pavement / bitumen / floor concrete, industrial class; Halo = its own tinted pave + terrazzo plazas).

## District roofs — Bazaar pitched roofs, hall vault, Terraces green roofs (branch tmp/city3-roofs, stacked on tmp/city3-ground)

The roof step of the texture pass (owner's pick "A" of three proofed finalists):

| Asset | Author | Licence | Source |
|---|---|---|---|
| clay_roof_tiles_02 (1K JPG set: Diffuse / Normal GL / Roughness / AO / ARM) | Poly Haven (Amal Kumar) | CC0 | https://polyhaven.com/a/clay_roof_tiles_02 |
| Grass004 (1K JPG set: Color / NormalGL / Roughness / AmbientOcclusion / Displacement) | ambientCG | CC0 | https://ambientcg.com/view?id=Grass004 |

Downloaded from Poly Haven's public API (the `arm` 1K JPG completes the `assets/ptex/clay_roof_tiles_02/` set the flat roofs already used at 512 px) and ambientCG's public API (set kept local in `assets/ambientcg/Grass004/`, gitignored). `mtex.py:ph_pbr` converts the Poly Haven set into the `tex_m/` layout as `roof_barrel` — diffuse with the ARM red channel (AO) multiplied in, Normal GL as the normal map, and a channel-packed companion in glTF metallicRoughness layout (R = AO, G = roughness, B = 0) that `pbr_override` wires G/B from, so the exporter ships it verbatim. `mtex.py:acg_pbr` converts Grass004 as `grass004` the same way.

Applied by `build_city.py`'s PBR overrides: the pitched-roof material (`roof_tile`, previously the 512 px `clay_roof_tiles_03` ingest) at one texture repeat = **2.6 m** on the authored metres/3 slope UVs; four per-building tint variants (`roof_tile_v1..v4`, subtle value/hue multipliers on the shared set, assigned as a pure function of building index) so the 77 roofs don't read as one sheet — the tint rides the material's `baseColorFactor` via a Mix (RGBA/MULTIPLY) node, the one tint pattern the glTF exporter folds into the factor (factors clamp at 1.0, so the brightest variant exports as a hue shift). The market hall's barrel vault is split into its own `roof_hall` material wearing the same set at a **5.2 m** repeat, its UVs rewritten to cumulative vault-arc metres/3. In Garden Terraces, `green_roof` surfaces move from a flat palette-moss quad to Grass004 at a 2.0 m repeat (`greenroof` material; roughness scalar overridden to 0.95 — the set's authored roughness map averages 0.26 and mkit materials take the scalar). Survey (build record): Terraces' other flat tops are finished terrazzo decks and `roof_grey` caps, so the Poly Haven `bitumen` companion named at selection was NOT applied there — no bare flat roof exists to receive it; Glass Quarter and Foundry Wharf flat caps already wear that same `bitumen` set, Foundry's sawtooth roofs are corrugated-iron PBR, and Halo's roofs are glass domes — no other district changes in this pass.

Fallback stand-in (NOT shipped — superseded by the pack above; kept here as the record of the earlier proof build on this branch):

| Asset | Author | Licence | Source |
|---|---|---|---|
| Lowpoly tree (with random season) — file `assets/blendkit/blenderkit-season-tree.blend` (local only, gitignored), decimated to 14,500 tris and flat-re-skinned by `assets_kit.tree_variants` (its SimpleProceduralLeaf shader is procedural and does not survive glTF export) | BlenderKit author (asset b9082156-eca0-4d99-bfae-c5ea20462f9b) | royalty_free (BlenderKit) | https://www.blenderkit.com |

LICENCE FLAG (unchanged, and the reason for the swap): BlenderKit Royalty Free assets should not ship in a directly extractable web GLB (see the "Not used, on purpose" note above). The conifer was an unshipped proof only; the CC-BY pack above is the shippable source. This branch remains unpushed/unmerged until the owner gives the ship word.

## District facades — Bazaar plaster, Terraces panels, Foundry brick, Halo plaster (branch tmp/city3-facades, stacked on tmp/city3-terraces-fix)

| Set | Source | Licence | URL |
|---|---|---|---|
| Plaster002 (1K JPG set: Color / NormalGL / Roughness / Displacement / NormalDX — no AmbientOcclusion map in this set) | ambientCG | CC0 | https://ambientcg.com/view?id=Plaster002 |
| concrete_panels (1K JPG set: Diffuse / Normal GL / Roughness) | Poly Haven (Amal Kumar) | CC0 | https://polyhaven.com/a/concrete_panels |
| worn_brick_wall (1K JPG set: Diffuse / Normal GL / Roughness) | Poly Haven (Amal Kumar) | CC0 | https://polyhaven.com/a/worn_brick_wall |

Downloaded from ambientCG's and Poly Haven's public APIs (no key needed). Sets kept local in `assets/ambientcg/Plaster002/` and `assets/ptex/<id>/` (gitignored, like the other downloads). `mtex.py:acg_pbr` converts Plaster002 as `plaster002` (tile 3.5 m; the ingest's AO step is skipped for this set — it ships no AO map, so AO = 1.0 and the packed companion's R channel is 255). `mtex.py:pbr` converts the Poly Haven sets at 512 px as `conc_panels` and as the three Foundry brick tints.

**Bazaar** — the five painted facade strips stay the base colour (they ARE the palette; layout and atlas untouched). The plaster reaches the walls by the two routes that survive glTF export, both verified by parsing the exported GLB: (1) its diffuse is baked into the strips by `textures.py` as a true per-channel mean-normalised multiply (clipped to the darkening range, gain-compensated; wall-pixel ratio vs the old strips measures mean 0.989 — the selection rig's recipe, baked because a texture × texture multiply is silently dropped by the Blender 5.2.3 exporter, probed head-to-head), sampled in strip-planar coordinates so it runs continuously up the atlas stack at a 3.5 m tile; (2) its NormalGL and channel-packed roughness ride a **wall-planar second UV channel** (u along the wall, v = world height, 3.5 m tile, emitted by `build_city.wallq` and `hero.outer` through `kit`'s uv2 plumbing) into the facade materials' stock Normal / metallicRoughness slots (exported as TEXCOORD_1 with texCoord 1 on both maps; the strip stays on TEXCOORD_0).

**Garden Terraces** — the `panel` material (balcony fascia bands + villa roof caps) moves from `brushed_concrete_04` to `concrete_panels` under its own tag `conc_panels`, so the shared `panel_conc` set — and with it Glass Quarter and Foundry, which also reference it — is untouched; applied at the existing 2.0 m panel tile. The terraces-fix deterministic wall rule is unchanged (plan byte-identical).

**Foundry Wharf** — the three loft brick tints (`brick_red` / `brick_dark` / `brick_cream`) move from `plaster_brick_pattern` to `worn_brick_wall` (tints (1.25, 0.82, 0.62) / (0.62, 0.47, 0.40) / (1.5, 1.38, 1.15)), same 2.0 m wall tile, so the district's red/dark/cream variety survives on a real worn-brick scan. The tints are set stronger than a neutral swap: the scan's base is a desaturated weathered brown, and at neutral tints the red family's chroma measured 0.19 against the old print's 0.475 — the strengthened tints restore the hue separation (the old print's full saturation was not the target; it was garish). The selection's shed companion `factory_wall` was NOT applied: Foundry's only shed-class structure, the market hall, is steel-column + metal-clad by design, and no concrete shed-wall class exists in the district (the set stays local and unused, as before).

**Halo Lagoon** — Plaster002 itself (`plaster` material, full diffuse + normal at the 3.5 m tile; roughness scalar 0.548, the set's authored mean — a satin, tadelakt-like finish) on the lathe-built stucco fields: tower plinths, terraced-dome rings, statue drums and monorail pier caps, using `lathe`'s existing metres-UV tile mode. The `marble` solid material keeps the formed elements (buttress blades, beams, coping) — they are emitted on palette-point UVs, where a texture would sample arbitrary single texels.

**Glass Quarter** — nothing, by design (glass-and-frame identity); its GLB is byte-identical before/after this pass.

## Foundry Wharf industrial pass

| Asset | Author | Licence | Source |
|---|---|---|---|
| Low poly Forklift Truck (1590 tris, stood up, width x0.8) | Kolos Studios | CC-BY 4.0 | https://sketchfab.com/3d-models/low-poly-forklift-truck-81b895de490646de8c6fb1ba03099e08 |
| Barrel 03 (1473 -> 600 tris) | Poly Haven | CC0 | https://polyhaven.com/a/barrel_03 |
| Wooden Crate 01 (6576 -> 299 tris) | James Ray Cock | CC0 | https://polyhaven.com/a/wooden_crate_01 |

Roller doors, containers v2, pallets, loaded pallets, oil drums and bollards are procedural (`tools/city3/industrial.py`). The forklift is kept local in `assets/sketchfab/forklift_kolos/` (gitignored, with its license.txt), fetched via the Sketchfab download API. foundry.py merges these rows into `out/asset-credits.json`; a later `build_city.py` run rewrites that file, so rerun foundry.py after it (or re-add the rows).
## Water — Bazaar moat + sea, Halo fountains + pools (branch tmp/city3-water)

The water step of the texture pass (owner's pick "B — Calm swell" of three proofed finalists):

| Asset | Author | Licence | Source |
|---|---|---|---|
| Water 002 (1K JPG set: Color / Normal / Roughness / Occlusion / Displacement) | 3DTextures.me | CC0 | https://3dtextures.me/2018/11/29/water-002/ |

Downloaded from 3DTextures.me (no key needed). The 1K set is kept local in `assets/3dtextures/Water_002/` (gitignored, like the other downloads); `mtex.py:tdt_pbr` converts it into the pipeline's `tex_m/` layout as `water002` — diffuse as downloaded (a flat colour swatch: the set's hue, not a picture), the OpenGL normal as the normal map (the convention the selection rig proofed in three.js; no green-channel flip), and a channel-packed companion in glTF metallicRoughness layout (R = AO, G = roughness, B = 0 metalness). The set's roughness map (authored mean 0.76, a soft satin) ships as a real texture map, not a scalar. Displacement is not used. Every water material also carries the physical F0 correction — Specular IOR Level 0.25 / IOR 1.333, exporting as `KHR_materials_specular` with factor ≈ 0.5 (water F0 0.02, half the dielectric default) — 0 bytes, JSON factors only.

Applied in the Bazaar by `build_city.py:water_mat`: the fused `Water` mesh is split — the fountain moat stays in the `water` bucket, emitted by the new `ring_water()` with per-corner planar UVs and its radii tucked 0.05 m under both basin walls (5.95 → 10.05 m), at the re-proofed fountain lever settings (**tile 5 m, normal strength 1.25** — the plan's §E.3 gate: the rig re-proof showed the added ripple energy at unchanged mean luminance, calm read intact); the sea moves to its own `sea` bucket/mesh/material with planar UVs at the proofed **tile 7 m**. The 8 jet-cap discs stay in the palette bucket deliberately (r 0.18 m, below judging distance). In Halo Lagoon, the shared water material becomes `pbr_mat("water", "water002", rough_map=True)` (mkit gains the opt-in packed-roughness input for this; default off, other districts unaffected) with the same Specular/IOR values: the two fountain discs in `fountain()` get world-planar UVs via `flat_ring(tile=7)`, and the lagoon-pool and wave-terrace roof-pool fans emit per-vertex `(x/7, y/7)` UVs in place of the palette point. Not water, left alone: Halo's `shallow` glass shelf ring, `jet` glass cones and `domeglass`. Survey: the Glass Quarter, Foundry Wharf and Garden Terraces have no open water surfaces — no other district changes in this pass.

## Fountain planter realism pass (2026-11-08)

| Asset | Author | Licence | Source |
|---|---|---|---|
| Planter Pot Clay | Amal Kumar | CC0 | https://polyhaven.com/a/planter_pot_clay |
| Potted Plant 04 (haworthia and gravel only) | James Ray Cock | CC0 | https://polyhaven.com/a/potted_plant_04 |

`fountain_planters.py` combines the scanned clay pot with the haworthia/gravel from the second asset. Four placements share two meshes (3,080 + 5,185 triangles) and their original 1K base-colour, normal and roughness maps. The source white container is omitted. `assets/fetch.sh` restores both inputs. These focal objects intentionally bypass `assets_kit._diffuse_only`: stripping normal/roughness maps would discard much of their surface detail.

## Mira — user-uploaded static resident (2026-11-08)

`Female+Maid+Facesless.zip`, supplied by the user for City3 placement. No author or licence document was included; this asset is not declared CC0. The source OBJ has 500,000 triangles and four 4K PBR maps. The public derivative (`/assets/residents/mira-maid.glb`) has 30,000 triangles, 1K maps and a grounded 1.68 m stature. There is no rig or animation. Source/derivative hashes and placement are recorded in `assets/mira_maid.json`; see `docs/procedural-city/16-mira-resident.md`.

Restore the original archive locally, then use `blender_lock.sh -b --python prepare_mira.py -- --source /path/to/extracted/archive --output /path/to/mira-maid.glb`. The script can create 1K textures directly from the original maps and optionally save an editable scene with `--blend-output`.

## Placed houses (2026-11-23)

Stand-alone prebuilt houses placed by `place_house.mjs` as their own streamed districts (`districts.json` `house-*`, files under `apps/console/public/assets/houses/`). Originals are kept outside the repo in `~/Developer/city3-downloads/`.

- `american-1`: "American House" by AleixoAlonso, CC-BY 4.0, https://sketchfab.com/3d-models/american-house-798ffaeadacf4e08a2665785422fb45d. Exterior only, solid collision box.
- `cabin-1`: "House - Stone Cabin - Modern Log Cabin 03" by MarMel-Bali, CC-BY 4.0 (Sketchfab uid 9e9195dc0a6f44b2baea0def83602dc7). Furnished interior; placed at 0.02 scale, door gap on the +z facade.
- `villa-pool-1`: "Modern luxury villa house building with pool" by zigurat architecture studio, CC-BY 4.0 (Sketchfab uid 0e858284939343cb994233d40a48a20a). Its own lot with pool and garden; solid collision over the house body.
- `mayflower-1`: House "May-Flower" (Design 39) by AleixoAlonso, CC-BY 4.0 (Sketchfab uid 1ff9aaa72bc24037ac3e3e08c9a35e33). Exterior only, solid collision.
- `shirakawago-1`: "Shirakawago Village Set House 1" by Lokomotto, CC-BY 4.0 (Sketchfab uid f94da738aefc4674ab2062df5c01cd43). 0.01 scale; thatch cards switched from BLEND to MASK (`--mask`); solid collision.
- `zen-pavilion-1`: "Zen Japanese Tea House with Go Board" by winters810, CC-BY 4.0 (Sketchfab uid a1e95e5efee349a693f30eda32401aef). Walkable: tatami floor sunk to 0.28 over the walk slab, 3.1 m gap in the open side, facing the Tea House.
- `villa-c-1`: "Modern luxury villa house building" by zigurat architecture studio, CC-BY 4.0 (Sketchfab uid d8e6be2601474f7d8cb7d06f8566f01a). Solid collision over the house body. `cabin-2` reuses the Stone Cabin (above) as "Lakeside Cabin".
- `clock-tower-1`: "Newmarket, Suffolk, UK - Jubilee Clock Tower" by epipolar, CC-BY 4.0 (Sketchfab uid 287e999f673846b38ab67ad366ef2aee), photogrammetry scan at 1.6x (24 m) in the plaza fountain, replacing the 38 m box tower.
- `victorian-green`: "Victorian house" by massive-graphisme, CC-BY 4.0 (Sketchfab uid dbb02bf8f5ed4851b05dd97a1784a1fb). Edge ring (ring_houses.py), solid collision.
- `residence-wsg`: "White Silver Green Residence" by Francesco Coldesina, CC-BY 4.0 (Sketchfab uid ec516ba32f03403f97954472c5d4b2cf). Edge ring (ring_houses.py), solid collision.
- `medieval-rx`: "Medieval house | Generic Textures | Game ready" by by__Rx, CC-BY 4.0 (Sketchfab uid 3eb9e3b600264e2f99100fc43619497e). Edge ring (ring_houses.py), solid collision.
- `kruglov-house`: "House of Kruglov" by D.U.H, CC-BY 4.0 (Sketchfab uid 8310706a996044e7bc3d8dc29594e841). Edge ring (ring_houses.py), solid collision.
- `suburban-bogdan`: "Suburban House" by Bogdan Strielecki, CC-BY 4.0 (Sketchfab uid efcc220c62f641d29a1480e8b221c7b3). Edge ring (ring_houses.py), solid collision.
- `small-brick`: "Small Brick House" by jimbogies, CC-BY 4.0 (Sketchfab uid c9ef0a360eff405682015c8813eee41d). Edge ring (ring_houses.py), solid collision.
- `cozy-cottage`: "Cozy Cottage" by SINNIK, CC-BY 4.0 (Sketchfab uid 72c05612ebbc4f5f8eac26d047d5d69c). Edge ring (ring_houses.py), solid collision.
- `suburban-blue`: "Suburban House" by mbuannoart, CC-BY 4.0 (Sketchfab uid b8375c5e5e6b40639fc06492fbd95fcb). Edge ring (ring_houses.py), solid collision.
- `colonial-american`: "American Colonial house" by Blue3D, CC-BY 4.0 (Sketchfab uid 3e536217e25545448762004ec55f1786). Edge ring lot ring-45-1, solid collision.
- `scandi-hawk`: "Hawk Lane Scandinavian Style House" by Azimuth Design, CC-BY 4.0 (Sketchfab uid 8d8a31fcca314f9cb334b04468f3d926). Edge ring lot ring-35-0, simplified to 50 %, solid collision.
- `log-cabin`: "Scandinavian Log Cabin" by rivetech, CC-BY 4.0 (Sketchfab uid e89718f746484189902162a91ae0b504). Edge ring lot ring-05-0, solid collision.
- Lido furniture (props-lido, tools/city3/props_lido.mjs), all CC-BY 4.0: "Sun lounger 3D" by rodestrela (Sketchfab uid 974e74f55bbd4dc9a85c4a48fc987a18),
  "White outdoor Umbrella" by Ngo.Phuoc.Truong (uid d6c9705a4f8e421ea473196ab9910088), "Sunchair" by hotdoghans (uid c2c86c8f882d46abb01d06ddf9d1d7a8).
- `finnish-cottage`: "Modern cottage, finnish style" by SlagPerch 3D, CC-BY 4.0 (Sketchfab uid f8d052ed3e634e46b6e83c3b2c006a0f). Edge ring lot ring-25-1, scaled 2.2x, solid collision.
- Lawn texture: "Leafy Grass" by Poly Haven, CC0 (https://polyhaven.com/a/leafy_grass), 1k colour + normal, tinted green, on every Bz*_grass lawn (bridge_lawn_texture.py).
- Plaza paving: "Cobblestone Floor 08" by Poly Haven, CC0 (https://polyhaven.com/a/cobblestone_floor_08), 2k colour + normal on cobble.001 (bridge_texture_swap.py).
- Sidewalk and block paving: "Pavement 03" by Poly Haven, CC0 (https://polyhaven.com/a/pavement_03), 2k colour + normal on sidewalk.001 (bridge_texture_swap.py).
- Ground palette (Poly Haven, CC0, 1k colour + normal, bridge_texture_swap.py): "Gravel Embedded Concrete" (garden and yard paths, Bz*_gravel), "Patterned Paving 02" (garden plazas, Bz*_stone), "Stone Tiles 02" (ring house walks, BzRing_stone), "Wood Planks" (lido deck, BzOpen_deck), "Patterned Brick Floor" (lido surround, BzOpen_stone). polyhaven.com/a/<id>.
- Block floors (Poly Haven, CC0, 1k): "Forrest Ground 01" (orchard meadow, BzOrchard_grass, tinted green), "Forest Leaves 04" (grove leaf litter, BzGrove_grass), "Wooden Planks" (lido deck, BzOpen_deck).
- House grounds (bridge_house_grounds.py): "Wood Chips" (bed mulch, BzGround_bed), "Herringbone Pavement" (back patios, BzGround_patio), Poly Haven CC0 textures; flower drifts are Poly Haven "Flower Gazania" (CC0, model, colour + alpha maps merged to one RGBA PNG). Boxwood balls are generated icospheres in the lawn's Leafy Grass maps.
- Sky lighting (apps/console/public/assets/env/sky_1k.hdr): Poly Haven "Kloofendal 48d Partly Cloudy (Pure Sky)" by Greg Zaal, CC0, 1k HDR; scene.environment for City 3 (glbStage.tsx StageEnvironment).

## The Villa — user-uploaded estate (2026-11-23)

`villa+3ds.3ds`, supplied by the owner for placement in the verse. No author or licence document was included; this asset is not declared CC0 and carries no external licence — it is the owner's own upload. The source 3DS (15,978,563 bytes, sha256 `0718f2c3f2f33c287980fc95623e99609fba3ddae9da608a9306abffe374cf0d`) references no texture images at all (0 of its 162 meshes carry UVs), so its 55 named materials are flat authored colours; the placed model's textures are procedural PBR maps generated in-workspace, keyed to those material names (see the texturing note below).

The public GLB (`/assets/villa.glb`, 31,024,848 bytes, sha256 `e5cbddd66e12c391163e4d12e01a1368f2d392cc58f607683236011f69dece9b`) is an assimp → trimesh conversion of the 3DS: 286 geometries, 1,265,477 triangles, one PBR material per 3DS material (base colour from the 3DS diffuse table) plus per-vertex normals. (The first conversion carried the colours as vertex colours with no materials and no normals; three.js then applies the glTF default material — metallicFactor 1 — and the walls rendered near-black. The re-bake changed shading data only: positions + indices are hash-verified identical.) A texturing pass (2026-11-23) then added generated box-projection UVs and procedural texture maps — 19 unique images embedded (872,488 bytes), 47 of 53 materials textured, glass + pool water factor-only — with every material's authored diffuse kept as its base colour; geometry is again hash-verified identical (the size growth over the 23,654,328-byte flat re-bake is the UV attribute on ~1.5M vertices, not the maps). Full record: `~/workspace/villa-view/texturing-note.md`. Per the owner's explicit instruction it is placed at FULL FIDELITY — no decimation or compression. The GLB's numeric space is the 3DS centimetre values; the ×0.01 metre normalisation lives in the placement data (`apps/console/src/features/world/VillaEstate.tsx`), the geometry bytes are untouched.

Placement: true size 54.00 m (X) × 13.38 m tall × 110.79 m (Z) — too large for any bazaar block (the street grid leaves no street-free run over ~55 m), so the estate stands on its own plot slab beyond the north rim at (0, 0.2, 252), rotated π so its forecourt faces the city. Since the dam pass (`bridge_villa_dam.py`, 2026-11-23) it is a visitable landmark place: the south link bridge deck and forecourt are in the resident collision set and baked navmesh; the house itself is one collision solid, no interior. Source/conversion details are recorded in `assets/villa.json`.

### Scandi Hawk ground-floor pilot

- [Hawk Lane Scandinavian Style House](https://sketchfab.com/3d-models/hawk-lane-scandinavian-style-house-8d8a31fcca314f9cb334b04468f3d926) by Azimuth Design, CC-BY 4.0. Split into a street shell and on-demand fittings, with a door opening and revised floor material.
- [Modern Sofa](https://sketchfab.com/3d-models/modern-sofa-ac92f6e97eaa43c4ad6cb8f7c65ac43f) by 3dimentionalben, [Carpet](https://sketchfab.com/3d-models/carpet-3e861135a1b742779f14e2f1bfa43072) by Hannah Sapiee, and [Pendente Mantra 30467](https://sketchfab.com/3d-models/pendente-mantra-30467-930a3ee08ca948c2abc70764de6bb8cc) by Homak, CC-BY 4.0. Rescaled and combined into the room library.
- Poly Haven CC0 assets [Laminate Floor 02](https://polyhaven.com/a/laminate_floor_02), [Coffee Table Round 01](https://polyhaven.com/a/coffee_table_round_01), [Side Table 01](https://polyhaven.com/a/side_table_01), [Ceramic Vase 01](https://polyhaven.com/a/ceramic_vase_01), and [Potted Plant 04](https://polyhaven.com/a/potted_plant_04). Embedded, converted for glTF, and resized for browser use.
- [Bar Chair Round 01](https://polyhaven.com/a/bar_chair_round_01), Poly Haven CC0. Two instances furnish the Scandi Hawk breakfast counter.
- [Vintage Day Bed](https://polyhaven.com/a/vintage_day_bed), [Painted Wooden Nightstand](https://polyhaven.com/a/painted_wooden_nightstand), and [Modern Ceiling Lamp 01](https://polyhaven.com/a/modern_ceiling_lamp_01), Poly Haven CC0. Resized and embedded in Scandi Hawk's room library for the south loft.

### Market Hall interior

- The hall interior reuses Poly Haven's [Wooden Crate 01](https://polyhaven.com/a/wooden_crate_01) by James Ray Cock and [Potted Plant 02](https://polyhaven.com/a/potted_plant_02) by Rico Cilliers, both CC0, from the existing City 3 library. The fitted stalls, stock, checkout terminal, tables, floor and frames are generated by `market_hall_mesh.py`.

## Hawk Lane trail and waterfront

| Asset | Creator | License | Source |
|---|---|---|---|
| Rock 09 | Jenelle van Heerden | CC0 | https://polyhaven.com/a/rock_09 |
| Namaqualand Stones 01 | Greg Zaal (photography), Jenelle van Heerden (modeling) | CC0 | https://polyhaven.com/a/namaqualand_stones_01 |
| Wooden Crate 01 | James Ray Cock | CC0 | https://polyhaven.com/a/wooden_crate_01 |

The trail uses three fitted scan variants. The waterfront stack uses the
full textured crate model. The streamed district retains the 1K base-color,
normal and roughness maps for all three assets.

The waterfront overlook uses [Oak Wood Planks](https://polyhaven.com/a/oak_wood_planks)
by Dimitrios Savva and [Metal Trash Can](https://polyhaven.com/a/metal_trash_can)
by GurJas Studios, both CC0. The clean can and handles are retained, with
the source lid fitted over the rim.

### Plaza fountain rebuild

- The coping and bronze nozzles are original procedural geometry from
  `fountain_architecture.py`. The stone finish reuses Poly Haven’s
  [White Plaster 02](https://polyhaven.com/a/white_plaster_02) CC0 color and normal
  maps already vendored for the Bazaar facades.
- Clock tower island paving uses Poly Haven’s [Marble Mosaic Tiles](https://polyhaven.com/a/marble_mosaic_tiles) CC0 color and normal maps from the existing floor library.

### Bazaar stalls

Two market stalls replace the single low-poly stall mesh (80 instances) in the bazaar
plaza. Both are by **Uğur Yakışık**, CC-BY 4.0, from the *Medieval Market Stall Asset*
set; geometry is decimated (2,599 and 1,700 tris), the embedded ground plane and the
normal/roughness maps are dropped, and base colour is capped at 256 px by
`tools/city3/stall_assets.py`. See `docs/procedural-city/29-bazaar-stalls.md`.

| variant | asset | source | licence |
|---|---|---|---|
| A (cloth canopy, produce trays) | Medieval Market Stall Asset Model 1/4 | https://sketchfab.com/3d-models/ee541c999b8a419ebc540d9461b2f693 | CC-BY 4.0 |
| B (wooden counter, pottery) | Medieval Market Stall Asset 4/4 | https://sketchfab.com/3d-models/cb20f7fb78f84347a1bb3b72403c9944 | CC-BY 4.0 |

## Real trees (tools/city3/assets/trees, bridge_real_trees.py)

Sketchfab downloads, normalised by `trees_normalise.py`, rebuilt by `trees_kit.py` (base colour only, KTX2 512 px). CC-BY: credit kept here.

| Kit file | Title | Author | License | Source |
|---|---|---|---|---|
| birch_11.glb | Birch | augro77 | CC Attribution | https://sketchfab.com/3d-models/b9b77a4301d4412db5182340972468e0 |
| birch_tree_4.glb | Birch tree | evolveduk | CC Attribution | https://sketchfab.com/3d-models/aa842dffd9654d33b8b91170ce83c172 |
| elm_tree_25.glb | Elm tree | evolveduk | CC Attribution | https://sketchfab.com/3d-models/f36443d3e59946bfa38b3f5cb90ea5fa |
| elm_tree_29.glb | Elm Tree | mhuang97 | CC Attribution | https://sketchfab.com/3d-models/cf70c356a8a54df8a007ec74be0241ab |
| fir_tree_99.glb | Fir tree | intice184 | CC Attribution | https://sketchfab.com/3d-models/0965de5def1342cd8b8b1a0fa5643e27 |
| japanese_cherry_tree_low_pol_13.glb | Japanese Cherry Tree (low-Poly) | Sereib | CC Attribution | https://sketchfab.com/3d-models/7c9e7c4e971f4953b06faf300cbb1209 |
| japanese_cherry_tree_medium__14.glb | Japanese Cherry Tree (medium-Poly) | Sereib | CC Attribution | https://sketchfab.com/3d-models/e0306a4402b44fa08f55aa58518dcb9c |
| larch_tree_101.glb | Larch tree | intice184 | CC Attribution | https://sketchfab.com/3d-models/d027dae8c92544d79b946edcea98deca |
| oak_tree_66.glb | Oak tree | greg-l | CC Attribution | https://sketchfab.com/3d-models/3dc59560f2d24345bdbe65c44636453b |
| poplar_tree_hight_texture_lo_106.glb | POPLAR TREE - HIGHT TEXTURE LOW-POLY MODEL | evseevdaniil0011 | CC Attribution | https://sketchfab.com/3d-models/ec7c1d301bbc43dca5fe5f0650148d13 |
| realistic_hd_blue_jacaranda__40.glb | Realistic HD Blue jacaranda (21/40) | PlantCatalog | CC Attribution | https://sketchfab.com/3d-models/be7c522d859a4ba4b28b64dc2715b976 |
| realistic_hd_blue_jacaranda__41.glb | Realistic HD Blue jacaranda (6/40) | PlantCatalog | CC Attribution | https://sketchfab.com/3d-models/f2c237c1669f4af1bd32ff6986942946 |
| realistic_hd_blue_jacaranda__44.glb | Realistic HD Blue jacaranda (26/40) | PlantCatalog | CC Attribution | https://sketchfab.com/3d-models/ed24ef4783964f62b161d765b0955375 |
| realistic_hd_blue_jacaranda__46.glb | Realistic HD Blue jacaranda (11/40) | PlantCatalog | CC Attribution | https://sketchfab.com/3d-models/9c3af078d6c54ed4818ac11fec5b34b1 |
| sakura_121.glb | Sakura | CubeModeller | CC Attribution | https://sketchfab.com/3d-models/1c11b84612a247d59af523ef86c96d52 |
| sakura_tree_01_low_poly_mode_114.glb | Sakura Tree 01 - Low Poly Model | thejogoss9 | CC Attribution | https://sketchfab.com/3d-models/147ae7d0d332456a99ec6195e9b0cd4f |
| spruce_tree_98.glb | Spruce tree | intice184 | CC Attribution | https://sketchfab.com/3d-models/7a5db417827244d98827459bce0cc944 |
| willow_125.glb | Willow | evolveduk | CC Attribution | https://sketchfab.com/3d-models/422de2372f3d46dfb314a0cd5da512fe |

### Movable apple pilot

- `apps/console/public/assets/props/market-apple.glb` — [Food Apple 01](https://polyhaven.com/a/food_apple_01) by Oliver Harries, CC0. Packed from the 1k glTF with its original textures, centred at the grip model origin and sized to 44 mm on the source rig. The runtime scales it with Remy’s cast scale.
