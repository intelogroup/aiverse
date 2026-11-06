# Third-party assets (City 3 interiors)

All assets are **CC0** (public domain dedication). No attribution is required; we credit the authors anyway.
They are not committed: `assets/fetch.sh` downloads them, and the build decimates them and resizes their
textures to 512 px before export into `world-city3-press.glb`.

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
