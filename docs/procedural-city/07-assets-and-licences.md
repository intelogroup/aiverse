# Free assets: sources, licences, recipes (checked 2026-11-06)

| Source | Licence | Reachable | Notes |
|---|---|---|---|
| **Poly Haven** models/textures/HDRIs | CC0. No attribution needed; the *live API* asks for a small "Powered by Poly Haven" credit | yes (`api.polyhaven.com`, `dl.polyhaven.org`, UA header required) | 521 models (85 furniture, 26 structures, 20 trees…). `GET /assets?t=models`, `GET /files/<id>` → `gltf/{1k,2k,4k}/gltf` with `include` map of textures + md5. Some models have no glTF (`decorative_book_set_01`). Also textures (`t=textures`) and HDRIs (`t=hdris`) — useful for facades/skies |
| **Quaternius** | CC0 | site yes; packs mostly on Google Drive (302, not followed). The "Furniture Pack" mirrors on **OpenGameArt** (`opengameart.org/sites/default/files/Furniture%20Pack%20by%20%40Quaternius.zip`) | OBJ/FBX are flat grey; colours only in .blend → recolour by slot name (`assets_kit._recolor`) |
| **Kenney** | CC0 | **blocked (403)** | itch.io mirrors untested |
| **Poly Pizza** | per-model | **blocked (403)** | |
| **BlenderKit** | "Royalty Free" (not extractable in a shipped game) or CC0 | REST API works (see Halo section, `02-environment.md`) | its FAQ says assets in a distributed game "shouldn't be directly extractable"; a web GLB is extractable → CC0 items only |
| **Synty POLYGON** | paid EULA | page only | unclear for raw models in a browser build; don't use without reading the One-Time-Purchase licence |
| **OpenGameArt** | per item (many CC0) | yes | check each listing's licence |

Credits live in `tools/city3/ASSETS.md` (+ `out/asset-credits.json`). Assets are *not* committed; `tools/city3/assets/fetch.sh` re-downloads them.

## Recipes
- Poly Haven model: fetch `files/<id>` → download gltf + `include` files into `assets/polyhaven/<id>/` (md5 check) → `assets_kit.load(id, budget_tris, tex=px)`.
- Poly Haven **texture** (PBR facade/ground): `files/<id>` → `Diffuse/1k/jpg`; for the city use base-colour only, tile in UV metres.
- Budgets that worked: furniture 1.5–4k tris, textures 128–512 px, whole library 2.4 MB / 45 assets.

## Sketchfab (added 2026-11-06)
API works with a user token (`SKETCHFAB_TOKEN` env var; never commit it). Search: `/v3/search?type=models&downloadable=true&licenses=cc0&q=...&max_face_count=...`
(the filter is `licenses=<slug>`, not `license=`). `assets/fetch_sketchfab.py name=uid ...` skips anything not CC0 and writes `meta.json` credit.
Used: Low Poly Medieval CC0 lantern/pot/produce crate, baked into the Bazaar stalls as linked duplicates (`assets_kit.load(source="sketchfab")`).

## Poliigon: NOT usable in shipped output (decision 2026-11-06)
Poliigon's licence (help.poliigon.com/en/articles/8749749) allows free assets on commercial projects but forbids redistribution, explicitly
"baking textures or embedding models and textures". Our GLBs are public downloads, so no Poliigon asset may be baked into them or committed.
Removed from the build; counters now use Poly Haven CC0 (CashRegister_01, ceramic_pot, metal_jug, brass_goblets). Poliigon is fine for private
offline renders only. The earlier commit 9d61a42..(this branch) still holds the old library GLB in git history.

## Sketchfab search notes
Search needs no token. Result `license` is `{uid,label}` (no slug) - match "CC0" in the label. Server `licenses=cc0` works but CC0 downloadable
low-poly street props are scarce (mostly museum scans); useful hit: "Low Poly Medieval, CC0" pack (bench, stall, crates; fetched to assets/sketchfab/med_*).
`max_face_count` server filter returned nothing - filter `faceCount` client-side. Download API needs a token (personal token via env var only).

## Bazaar: Sketchfab "Low Poly Medieval, CC0" props (2026-11-06)
Fountain-ring and plaza-rim benches are now `med_bench` (616 tris, backrest on +y in Blender axes, rotate -90 deg for the other axis) and ~60% of stalls get a `med_crate`
(`build_city.py`, `BENCHES` list + `_skput`). Street-front benches along facades stay procedural. Seen in screenshots: benches read well, backrests face outward from the fountain.
Village stall (`med_stall`, 752 tris): ~35% of the 80 stalls (`MEDSTALLS`, seeded per stall index) use it instead of the procedural stall, scaled (1.4, 1.4, 1.2); the
scalloped awning edge is its -y side (rot 0 for facing S, pi for N). Verified from the plaza side for S-facing stalls; N-facing orientation not yet checked in a screenshot.

## Bazaar stall goods (2026-11-06, branch decor/stall-goods)
Replaced the tinted-cuboid goods (and the 80 `SK_producecrate` with their boxes) with 11 stall stocks: fruit, veg, grain, spice, cloth, pottery, bakery, dairy, wine, lamps, baskets.
- Sketchfab Avramania "Low Poly Medieval, CC0" (all CC0): Basket aef0f7e9, Grain Sack 7db2a145, Sack 3deb43fe, Roll 9cd0c6d3, Cheese Wheel c66175e5, Barrel 72b75758 (+ Pot / Lantern already in use); `Fruit Basket` 736ae73e fetched, unused. Search recipe: the public search finds the pack only with its full title, e.g. `q="Basket Low Poly Medieval CC0"`, then filter `user.displayName == "Avramania"` (plain "basket" / "sack" returns other authors).
- Poly Haven CC0: `wooden_bucket_01`, `metal_jug` (the jug key is also used by the interior library, so the goods copy is loaded under its own name `g_metal_jug` at 300 tris; the library keeps its 2000-tri version).
- Procedural (palette, no texture): fruit / veg crates and heaps (icosphere 20 tris, per-fruit colour from the palette), spice trays, cloth, pottery, bottles, bread, hanging strings. No CC-BY used, nothing new in `asset-credits.json` except the CC0 entries of the loaded assets.
- Budgets: real assets decimated to 170-340 tris, textures 128 px (the pack's palette image is 256 px, 1 KB); procedural pieces 100-560 tris.

## Agora 2 spike sources (2026-11-06, not shipped)
- Quaternius Modular Sci-Fi MegaKit Standard (CC0, 190 glTF): itch.io `POST <page>/download_url` -> download page -> `POST <page>/file/<upload_id>?source=game_download` (60 s signed URL).
- Kenney Modular Space Kit (CC0): direct zip on OpenGameArt (`kenney_modular-space-kit_1.0.zip`).
- BlenderKit: API search works without a key. Free assets are mostly **royalty-free, not CC0**; FAQ allows them in games only "if the models can't be extracted easily" -> a public web GLB is easy to extract -> excluded (same reasoning as Poliigon). CC0 BlenderKit assets only.
- BlendSwap MCP: CC0 filter works, licences are uploader-declared; useful hits: Round Robot (rigged), Low Poly Rock Formation #2, Beach Cliff scan.

## Halo Lagoon sources (2026-11-06)
- **BlenderKit CC0 works end-to-end** (recipe in `02-environment.md`): downloaded "Blue Striped beach chair" glb (`assets/blendkit/beach_chair/`).
  Branded cars (Ferrari/BMW etc.) are CC0-tagged but avoid them (trademarks); generic "car" is batmobile-styled -> skipped.
- **BlendSwap CC0** (`assets/blendswap/`): #20393 "Tropical Palm Tree (Cycles)" by TheMav — 37k tris of geometric leaves; decimating to game budget shreds the
  fronds -> not used as mesh. #5812 "Palm Tree Cycles Ready" by SSimpossible — `PalmFrondDiffuse.png`/`PalmFrondAlpha.png` alpha-masked frond texture -> used on
  procedural alpha-card fronds.
- **Sketchfab** CC0 searches for palm/tropical/plant/bush/parasol/car/yacht return almost only museum scans -> not useful.
- **Poly Haven** fetched: models outdoor_table_chair_set_01, bronze_whale_statue, bronze_ray_statue, bronze_shark_statue, CoffeeCart_01, planter_box_01,
  potted_plant_04, lifebuoy; texture palm_tree_bark.

## Foundry Wharf industrial pass (2026-11-07)

| Asset | Author | Licence | Source |
|---|---|---|---|
| Low poly Forklift Truck (1590 tris, stood up, width x0.8) | Kolos Studios | CC-BY 4.0 | https://sketchfab.com/3d-models/low-poly-forklift-truck-81b895de490646de8c6fb1ba03099e08 |
| Barrel 03 (1473 -> 600 tris) | Poly Haven | CC0 | https://polyhaven.com/a/barrel_03 |
| Wooden Crate 01 (6576 -> 299 tris) | James Ray Cock | CC0 | https://polyhaven.com/a/wooden_crate_01 |

Roller doors, containers v2, pallets, loaded pallets, oil drums and bollards are procedural (`tools/city3/industrial.py`). The forklift is kept local in `assets/sketchfab/forklift_kolos/` (gitignored, with its license.txt), fetched via the Sketchfab download API. foundry.py merges these rows into `out/asset-credits.json`; a later `build_city.py` run rewrites that file, so rerun foundry.py after it (or re-add the rows).

## Cast bodies (added 2026-11-07)
| Body | Source | Licence | Note |
|---|---|---|---|
| Skeleton Warrior (`cast-skeleton-warrior.glb`) | KayKit "Character Pack: Skeletons" 1.0, Kay Lousberg | CC0 (LICENSE.txt in the pack) | PR #30; Body Block's 45 clips retargeted with the Adventurers wave's matrix-delta bake; no attribution required |
| Remy (`cast-remy.glb`) | Mixamo (Adobe) `Remy.fbx` | Mixamo terms, not CC0 | PR #29. Free for commercial and non-commercial use inside a finished product; **you may not distribute the raw character or animation files** (asset packs, stores), no ML-training use; attribution not required. Source: Adobe Mixamo FAQ as reposted on the Adobe community forum, Sept 2022 (https://community.adobe.com/t5/mixamo-discussions/mixamo-faq-licensing-royalties-ownership-eula-and-tos/td-p/13234775); could not confirm it is still current, check Adobe's Terms of Use. Open question: a GLB committed to a public repo and served from `public/assets/` is arguably "distributing the raw character"; decide before the repo goes public or the console is shared widely. Summer is a Mixamo-rigged character of the user's own (`Sitting_small_0_ex78.fbx`) with the same caveat. |
| Cipher (`cast-cipher.glb`) | Mixamo (Adobe) "Soldier" character, uploaded by Jim as `Entering Code.fbx` | Mixamo terms, not CC0 (same caveat as Remy/Summer above) | Body Block's 53-clip catalog retargeted with `tools/city3/bake_cipher.py`; the raw FBX is NOT committed. walkSpeed/Run are estimates, see the comment in `bodies.ts` |
| Eve (`cast-eve.glb`) | Mixamo (Adobe) "Space Pirate", uploaded by Jim as `Eve By J.Gonzales.fbx` | Mixamo terms, not CC0 (same caveat as Remy/Summer) | Same bake as Cipher; source 1.39 m, shown at 1.65 m; raw FBX NOT committed; walkSpeed/Run are estimates |
| Elf (`cast-elf.glb`) | Meshy (fal.ai, Meshy 7.1 multi-image-to-3D) from Jim's reference images, 2026-11-11 | Meshy generation terms, not CC0 — AI-generated from Jim's own reference images; rig is Meshy's Mixamo template | Body Block's 53-clip catalog retargeted with `tools/city3/bake_meshy.py` (stray Meshy "Icosphere" dropped); source GLB NOT committed; walkSpeed/Run stance-measured, see `bodies.ts` |
| Jim (`cast-jim.glb`) | Meshy (fal.ai, Meshy 7.1 multi-image-to-3D) from Jim's own reference photos, 2026-11-11 | Meshy generation terms, not CC0 — AI-generated from Jim's own photos; rig is Meshy's Mixamo template | Same bake as the Elf; source GLB NOT committed; walkSpeed/Run stance-measured, see `bodies.ts` |

## Speech (Phonon TTS, 2026-11-07)
| Asset | Source | Licence | Notes |
|---|---|---|---|
| `phonon-tts` engine (npm 0.6.0) | gradium-ai/xn-ptts | MIT OR Apache-2.0 | runs in the tab (WASM worker) |
| Model `gradium/phonon-31m-en` q8 GGUF, pinned revision 8c64b55e | Hugging Face | Apache-2.0 (per the model card; the 40M / multilingual checkpoints are CC-BY-NC and NOT used) | fetched at runtime, not in git |
| Voices "Zoey", "Master Aldric", "Hugh" (`public/assets/tts/voices/*.safetensors`) | Hugging Face `gradium/phonon-voices` @ 0ee17205 (`voices.jsonl`) | Apache-2.0 (repo licence) | designed catalog voices, not clones of real people |
| Clips `public/assets/tts/lines/{mage,summer}*.mp3` | rendered locally with the engine + voices above | as the model | fallback while the engine warms |
| Clips `public/assets/tts/lines/bartender{1,2}.mp3` | rendered in this repo's console with "Hugh" (ffmpeg, 24 kHz mono 48 kbps) | as the model | fallback while the engine warms |

## Tea House floors (2026-11-12)
Poly Haven CC0 textures (colour + GL normal, 512 px, herringbone 1024), `tools/city3/assets/tea-floors/` (+ `sources.json` with author and tile size): hinoki_planks, oak_wood_planks, herringbone_parquet, tatami_mat, wooden_floor_02, laminate_floor_02, interior_tiles, floor_tiles_06, patterned_terracotta_tiling, marble_mosaic_tiles, stair_planks. Authors: Charlotte Baglioni, Dimitrios Savva, Jenelle van Heerden, Sergej Majboroda, Rico Cilliers, Dario Barresi, Rob Tuytel, Amal Kumar. Poly Haven asks for a "Powered by Poly Haven" credit where practical.

## Tea House furniture (2026-11-12)
Poly Haven CC0 models, decimated to 470-1,500 tris (`tools/city3/tea_house/prep_props.py`) with 512 px colour (+ normal on the Chinese set and the bookshelf), `tools/city3/assets/tea-props/` (+ `meta.json`): chinese_tea_table, chinese_stool, chinese_armchair, chinese_sofa, chinese_console_table (Kirill Sannikov); wooden_bookshelf_worn, round_wooden_table_02 (Ulan Cabanilla); painted_wooden_table, painted_wooden_bench, painted_wooden_nightstand, sofa_02 (Kirill Sannikov); painted_wooden_chair_01, mid_century_lounge_chair (Kuutti Siitonen); vintage_day_bed (Aron Lyczek); side_table_01, planter_box_01 (James Ray Cock); modern_coffee_table_01 (Amin).
Considered and NOT used: CGTrader free models (royalty-free, "must not be extractable by third parties"; a public web GLB is extractable, same reason BlenderKit is excluded); Sketchfab `licenses=cc0` returned nothing for tea set / shoji / tatami / lantern on 2026-11-12.
