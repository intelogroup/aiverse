# Decor probe: BlendKit + BlendSwap (2026-11-06, research only, nothing downloaded)

Goal: free (CC0 / CC-BY) props to replace coloured-box placeholders in shop / cafe / library / workshop / tea interiors (`tools/city3/rooms.py`, `press.py`).
Method: BlendKit REST `search/?query=<q> asset_type:model license:cc_zero is_free:true` (no key written anywhere), BlendSwap MCP `search_assets` (cc0,cc_by). No `download_asset` calls.

## Headline findings
1. **BlendKit has no CC-BY class.** `license:cc_by` / `cc-by` / `cc_by_4` return 0 hits. Licences present are only `cc_zero` and `royalty_free` (royalty-free is excluded by our own rule, see 07). So BlendKit = CC0 only.
2. **A large share of BlendKit CC0 is a Poly Haven mirror** (author "Poly Haven", `sourceAppName PolyHavenToBlendKit.py`, face count unlisted). Fetch those from Poly Haven directly (`fetch_polyhaven.py`, glTF available, md5 checked), not via BlendKit's 500 MB .blend. Already in `assets/polyhaven/`: ArmChair_01, CashRegister_01, ceramic_pot, brass_goblets, metal_jug, wooden_bookshelf_worn, book_encyclopedia_set_01, vintage_oil_lamp, desk_lamp_arm_01, wooden_crate_01, drawer_cabinet. Skipped below.
3. **BlendKit "faceCount" is the artist's reported count, almost always 1k-30k+ for hero props.** Nearly everything exceeds the 300-tri bottle budget by 3-30x. Only a handful are really low-poly (marked LOW below). Plan on decimating / or baking to a shared atlas. Poly Haven mirrors list no count (typically 2-20k).
4. **No bottle pack exists** in either source that fits "hundreds of 200-300 tri bottles" besides BlendSwap #9787 (explicit "low poly for games", CC-BY) and #33793 (CC0, 4 bottles, 129 KB file = very light). Both are .blend only.
5. **No whole market / grocery / merchant / apothecary / teahouse / samovar / liquor / olive-oil kit** on BlendKit (queries returned 0 or off-topic: toilet, rifle, etc.). BlendSwap "market stall" and "cash register" also 0 hits. Best "pack-like" hits are BlendSwap #25903 (Kitchen Asset Library) and #30601 (tea sets).
6. Counters, menu boards: nothing purpose-made. Use BlendKit Poly Haven `Coffee Cart 01`, `Standing Chalkboard 01`, `Chinese Tea Table`, or keep procedural counters.
7. BlendSwap licence is uploader-declared (unverified), formats are mostly `.blend` (2.6x-3.x; old Cycles scenes need material bake). Free plan: 5 of 7 daily downloads left; keep asset count small. Several CC0 BlendSwap entries embed trademarked textures (Absolut, Jack Daniels, Coca-Cola, Heineken/Marlboro): avoid those.

Style note: almost everything is realistic PBR, not stylised. For warm golden-hour look we will recolour/atlas anyway; low-poly stylised options are rare (the only `lowpoly` hits were a humanoid and a jack-o-lantern).

## Candidates (25 + extras)
Faces = value reported by the source listing (not verified). "ours" = what it replaces.

### Shelf bottles / jars / tins (hundreds placed -> need LOW)
| # | Source | Id | Name | Licence / author | Faces | Replaces | Notes |
|---|---|---|---|---|---|---|---|
| 1 | BlendKit | d76ba5cd-4a1c-45f1-9195-78635209cb37 | Glass vodka | CC0 / Dr Blender | 962 | vodka/spirits bottle | glTF uploaded; decimate to ~250; best BlendKit spirits bottle |
| 2 | BlendKit | af6bb078-08d0-441d-b625-d43c6ec186bd | Glass Bottle | CC0 / Free poly | 1148 | generic bottle / oil | glTF; plain glass, recolourable |
| 3 | BlendKit | b8e2709c-a357-4674-a6b5-bb9d4ae67de1 | Soup Jar | CC0 / Free poly | 284 | jar / tin | LOW, within budget as-is; no glTF flag |
| 4 | BlendKit | a8e4cc78-56da-4cdf-8377-da301cd28018 | Long Life Food (tins) | CC0 / Poly Haven | 2410 | tins | PH mirror, use polyhaven.com; decimate |
| 5 | BlendKit | e0b8760e-e9de-4919-b1cb-7d3e24e3b4f6 | Chandon champagne bottle | CC0 / Flareworks Studio | 4955 | wine bottle | branded label (trademark, avoid or strip label) |
| 6 | BlendKit | 06e22946-d63f-4c14-b622-54141faeee72 | Wine Bottles 01 (4 bottles) | CC0 / Poly Haven | n/a (8K) | wine bottles | PH mirror; good variety, decimate hard |
| 7 | BlendKit | c273dc7a-9b7d-4d60-b4c0-81cfcfb955f7 | Glass Pot | CC0 / Jonathan Ramos | 1566 | glass jar | restaurant-bar category |
| 8 | BlendSwap | 33793 | Low-Poly Bottle Pack (4 bottles) | CC0 / coldpengu | LOW (129 KB file) | shelf bottles | best fit for budget; .blend only, count unlisted |
| 9 | BlendSwap | 9787 | Bottles Pack - Low Poly (4 types + destroyed) | CC-BY / LightningStudio | LOW ("for games", 128px AO) | shelf bottles | needs attribution; Blender 2.6x file |
| 10 | BlendSwap | 8909 | Italian style still life (olive oil, vinegar, garlic) | CC-BY / BhaWin | unknown, 12 MB | oil/vinegar bottles | Cycles scene; extract bottles |
| 11 | BlendSwap | 25903 | Kitchen Asset Library-Pack photoreal Vol.1 | CC0 / Davilion | high (17 MB) | jars, tins, ceramics, kitchen goods | a real pack; 3.2k downloads; likely 100+ objects |
| 12 | BlendSwap | 28153 | Realistic Whiskey Bottle with fake liquid | CC0 / domipior | unknown | spirits bottle | geometry-node liquid; bake needed |

### Shelf goods (cloth, baskets, ceramics, books)
| # | Source | Id | Name | Licence / author | Faces | Replaces | Notes |
|---|---|---|---|---|---|---|---|
| 13 | BlendKit | 50e3b3c4-7e54-4e80-b45d-e76195bbefe2 / 44bf4de1-d5c9-45d4-ba5c-aefdb5c07925 | Wicker Basket 01 / 02 | CC0 / Poly Haven | n/a | baskets | PH mirrors, fetch from polyhaven.com |
| 14 | BlendKit | e24bc8ef-d609-465c-bbb8-52fdc7359917 (+ 24cf74c1..., 0df7fa14..., c6fb45b5..., 4ae3bb9d...) | Old Book series | CC0 / Joshua Whitney | 22-158 | books on shelves | LOW; five titles, great for library; 158-tri one has glTF |
| 15 | BlendKit | 9d289aa5-c51a-49f2-a190-e3e7c5158c82 | Tea Set 01 | CC0 / Poly Haven | n/a | tea set | PH mirror |
| 16 | BlendKit | 1845cb0b-1c7b-4805-976d-442a5607d257 | Teapot | CC0 / Luke Graybill | 899 | teapot | cheapest teapot found |
| 17 | BlendSwap | 30601 | Power of tea sets 2022 | CC0 / GTaurus | unknown, clay shader | tea sets | multi-piece pack, plain material = easy to recolour; 863 dl |
| 18 | BlendSwap | 31133 | Vintage teapot | CC-BY / animatedheaven | "low-polygon PBR" | teapot | needs credit; also FBX/OBJ per description |
| 19 | BlendSwap | 31027 | Tea Cup Set - Symbols | CC-BY / Ed Eien No Janed | 353 faces (pre-modifier) | tea cups | 4K textures, downscale |
Cloth rolls / fabric bolts: **nothing found** on either site (BlendKit "cloth roll" returned scans, clothing, a rifle). Keep procedural cylinders + fabric texture.

### Furniture, fire, counters
| # | Source | Id | Name | Licence / author | Faces | Replaces | Notes |
|---|---|---|---|---|---|---|---|
| 20 | BlendKit | 82597b9f-33be-414a-9d0d-f58b5fc54e3b | Ikea Onnestad Red Armchair | CC0 / YULIN LAND | 5812 | armchair | glTF; brand name only |
| 21 | BlendKit | 4d6cca18-c0c6-4712-a332-68cbe6bd8c77 | Vintage Day Bed | CC0 / Poly Haven | 2715 | sofa / divan | PH mirror, glTF; reads well for a tea house |
| 22 | BlendKit | 65d6e7e7-61f6-4d26-b497-4258613d0449 | Mid Century Lounge Chair | CC0 / Poly Haven | 3161 | armchair | PH mirror |
| 23 | BlendSwap | 30053 | Diwan sofa (oriental diwan) | CC0 / Darilon | unknown, 1 MB | sofa / booth seating | oriental-flavoured, directly on-theme for a bazaar tea house |
| 24 | BlendKit | 9dbec0a2-36ae-4693-b090-757884729408 | Scandinavian Masonry Heater | CC0 / Poly Haven | 4967 | fireplace | PH mirror, glTF |
| 25 | BlendSwap | 28913 | Cast Iron Wood Stove | CC0 / Shmojoe14 | unknown (40 MB) | fireplace | flame = PNG on emission; also #31086 Brick fireplace (CC0, 76 MB) too heavy |
| 26 | BlendKit | beae0093-b77c-4650-952b-6307c7c56bf3 | Chinese Tea Table | CC0 / Poly Haven | 1418 | tea-house display table | PH mirror, glTF |
| 27 | BlendKit | d2c31d11 (Coffee Cart 01) | Coffee Cart 01 | CC0 / Poly Haven | n/a | counter | already have `CoffeeCart_01` locally |
| 28 | BlendKit | b54e3b3b-5ab4-4d2e-bb4d-414e0c2d7707 | Cash Register 01 | CC0 / Poly Haven | n/a | cash register | already in `assets/polyhaven/CashRegister_01`; BlendSwap has no register |

### Lamps, lanterns, frames, rugs, boards
| # | Source | Id | Name | Licence / author | Faces | Replaces | Notes |
|---|---|---|---|---|---|---|---|
| 29 | BlendKit | 9e80c469-866b-46ac-b385-2cab22231b37 | Japanese Wood Lamp | CC0 / Davide Tirindelli | 1208 | lantern | glTF |
| 30 | BlendKit | a2a41efc-4b78-469c-87ed-0a7800301dd3 | Japanese Wood Lantern | CC0 / Davide Tirindelli | 4454 | lantern | glTF |
| 31 | BlendKit | e76dc427-bb7a-436a-b2ce-30b6659d3e4f | Japanese Hanging Paper Lantern | CC0 / Davide Tirindelli | 9726 | hanging lantern | warm glow; decimate |
| 32 | BlendSwap | 26978 | Traditional Chinese Lantern (made for a teahouse) | CC0 / RyanANeily01 | unknown (347 MB!) | tea-house lantern | huge file because of textures; only if needed |
| 33 | BlendKit | 544c0467-f794-415f-8f19-95d8e226ef00 | Corner Lamp Warm White | CC0 / Roland Schuller | 942 | floor lamp | LOW-ish; also 655d14b8... Expoy Wood Floor Lamp 2154 |
| 34 | BlendKit | 58e26712-fd12-4167-8ff5-1ddafef9697f | Tubular floor lamp_DL | CC0 / dleon3D León | 4959 | floor lamp | alt |
| 35 | BlendKit | d8a56c79-5c44-4c01-bafd-426695a9c18a | Blackboard | CC0 / Kin Chen | 158 | menu board | LOW, restaurant-bar category; also PH `Standing Chalkboard 01` (fa9e3281...) |
| 36 | BlendKit | 8931c1b2-16ad-4888-987b-69d60f60f8fe | Nature picture | CC0 / Jan Holinka | 6 | wall frame | trivially cheap; PH Hanging Picture Frame 01/02/03 and Fancy 01/02 also exist (mirrors, no count) |
| 37 | BlendKit | 949987d2-8db7-47cc-80a4-5a449dcadfc8 | Carpet | CC0 / Cyberking 42 | 22464 | rug | too dense; rug is better done as a textured plane |
| 38 | BlendSwap | 31243 | Rugs CC0 | CC0 / DragoЛ | strand-based | rug | 235 MB scene; use only as a texture reference |

### Searched, nothing usable
- BlendKit: wine-rack packs, liquor/spirits packs, olive-oil bottle, apothecary, teahouse, samovar, market stall, grocery packs (a "Scan Ginger" only), cloth bolts, booth seating (only a telephone booth and a clinic "Privacy Booths").
- BlendSwap: market stall, cash register (0 hits). Armchair/sofa hits are mostly high-poly archviz (50-380 MB .blend).
- CC-BY on BlendKit: not a thing.

## Recommended picks (best 8)
1. BlendSwap #33793 Low-Poly Bottle Pack (CC0): only in-budget bottle set; spend one daily download.
2. BlendKit d76ba5cd Glass vodka (CC0, 962 tris, glTF): decimate to ~250, recolour for spirits.
3. BlendKit Old Book series, Joshua Whitney (CC0, 22-158 tris each): library/shelf books.
4. BlendKit Teapot 1845cb0b (CC0, 899) + BlendSwap #30601 tea sets (CC0): tea house tableware.
5. BlendSwap #30053 Diwan sofa (CC0): on-theme seating for tea house / booth.
6. BlendKit Japanese Wood Lamp 9e80c469 (CC0, 1208) / Hanging Paper Lantern e76dc427: warm lanterns.
7. BlendKit Blackboard d8a56c79 (CC0, 158): menu board; plus Nature/Flower picture (6 tris) for wall frames.
8. BlendKit Vintage Day Bed 4d6cca18 + Chinese Tea Table beae0093 (CC0, Poly Haven mirrors, glTF): fetch from polyhaven.com directly.
Runners-up: BlendKit Soup Jar b8e2709c (284 tris jar), Wicker Basket 02 (PH), BlendSwap #25903 Kitchen Library (pack to mine for jars/tins/ceramics), BlendSwap #28913 Cast Iron Stove.

## Next steps if pursued
- Use BlendKit download flow from `02-environment.md` only for non-PH items; PH mirrors via Poly Haven.
- BlendSwap items arrive as .blend zips; budget downloads (5 left today on free plan) and prefer #33793, #30053, #30601, #25903.
- Run `assets_kit` decimation; bottles: one atlas + instancing, strip trademark labels.
- Attribute CC-BY items (#9787 LightningStudio, #31133 animatedheaven, #31027 Ed Eien No Janed) in `ASSETS.md` if used; prefer CC0 to avoid this.
