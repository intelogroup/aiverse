# Decor asset probe: Poly Haven + Sketchfab (2026-11-06, research only, nothing downloaded)

Method: Poly Haven `api.polyhaven.com/assets?t=models` (521 models; `polycount` field = tris) filtered by keyword; Sketchfab v3 search
`downloadable=true&licenses=cc0,by` and a CC0-only pass, face count filtered client-side (<=20k), then `/v3/models/<uid>` for licence/author/faces.
Already local (not re-suggested): PH ArmChair_01, CashRegister_01, CoffeeCart_01, WoodenTable_02, binder_notebook, book_encyclopedia_set_01, brass_goblets,
ceramic_pot, desk_lamp_arm_01, drawer_cabinet, metal_jug, vintage_oil_lamp, wooden_bookshelf_worn, wooden_crate_01, wall_clock, potted_plant_02/04, planter_box_01;
Sketchfab lantern, pot, producecrate, med_bench/crate/producecrate/stall.

Caveats (honest):
- **Texture size is NOT known for Sketchfab** (the `/textures` endpoint returned nothing for us and `archives.gltf` is empty until a download is requested); check after fetch. Poly Haven: 1k/2k/4k selectable, we use 1k or less.
- **Sketchfab "CC0" is rare**: CC0-only searches for bottle/jar/rug/sofa/armchair/lamp/frame/register/counter/teapot returned nothing usable (only museum scans). Almost every good hit is **CC-BY** (credit needed; add to `tools/city3/ASSETS.md`). Titles starting "CC0 - ..." by `plaggy` are actually **CC-BY** per the API: credit them.
- Sketchfab `faceCount` is tris. Bottle "packs" hold several bottles in one mesh: per-bottle count = pack tris / N; split/decimate in Blender (<=300 tris each).
- Poly Haven has **no sub-1000-tri bottle, jar or tin**: every bottle model is 4k-30k tris (decimation would wreck it). Nothing found for rugs, menu boards (except a chalkboard), booths or floor lamps on PH.
- BlenderKit/BlendSwap not searched here (doc 07 already limits them to CC0 only).
- Style: PH is photoreal PBR; Sketchfab hits are mostly hand-painted/low-poly, so bottles/rugs/books will look stylised next to PH furniture. Fine for a warm bazaar if tinted, but check screenshots.

## A. Poly Haven (CC0, no credit needed; "Powered by Poly Haven" for API use)
| # | id | name / author | tris | tex | replaces |
|---|---|---|---|---|---|
| 1 | `chinese_sofa` | Chinese Sofa, Kirill Sannikov | 704 | up to 4k (use 1k) | `sofa_3` (very cheap, tea-house look) |
| 2 | `chinese_armchair` | Chinese Armchair, Kirill Sannikov | 2675 | 1k ok | `armchair_blue/red` (tea house) |
| 3 | `chinese_tea_table` | Chinese Tea Table, K. Sannikov | 2508 | 1k | `display_table_a/b`, tea seating |
| 4 | `painted_wooden_sofa` | Painted Wooden Sofa, K. Sannikov | 5826 | 1k | `sofa_3` / `booth_2m` bench (heavier) |
| 5 | `painted_wooden_shelves` | Painted Wooden Shelves, K. Sannikov | 524 | 1k | carcass of `shelf_bottles_*` / `shelf_goods_*` (then fill with props) |
| 6 | `Shelf_01` | Shelf 01, Gabriel Radic | 182 | 1k | cheapest shelf carcass |
| 7 | `wooden_display_shelves_01` | James Ray Cock | 3174 | 1k | `shelf_goods_a/b` carcass |
| 8 | `fancy_picture_frame_01` | Rob Tuytel | 938 | 1k | `frames_wall` |
| 9 | `hanging_picture_frame_01` / `_02` | James Ray Cock | 2586 / 3678 | 1k | `frames_wall` |
| 10 | `standing_chalkboard_01` | ParzivalCG | 2372 | 1k | `menu_board` |
| 11 | `tea_set_01` | James Ray Cock | 40296 | 1k | tea sets (needs decimating to ~3k; too heavy as is) |
| 12 | `lantern_chandelier_01` | K. Sannikov | 5971 | 1k | hanging lanterns (tea house) |
| 13 | `brass_diya_lantern` | Bhargav Kubal | 12742 | 1k | hanging lantern (heavy, decimate) |
| 14 | `ottoman_01` / `throw_pillows_01` | Caspian Fortune / S. Khromov | 4240 / 6362 | 1k | sofa/booth cushions |
| 15 | `scandinavian_masonry_heater` | Kuutti Siitonen | 9350 | 1k | `fireplace` (stove, not open hearth; decimate) |
| 16 | `russian_food_cans_01` | Kosan Aziz | 1348 (set) | 1k | `shelf_bottles_c` tins (set of cans; split) |
| 17 | `wicker_basket_02` | Kuutti Siitonen | 17850 | 1k | `shelf_goods` baskets (needs heavy decimation; prefer Sketchfab #B6) |
| 18 | `wooden_table_02` (local) / `painted_wooden_table` | K. Sannikov | 600 | 1k | `display_table_*` |

## B. Sketchfab (uid, licence, author, faces, use)
CC0:
| # | uid | name | author | faces | replaces |
|---|---|---|---|---|---|
| B1 | `db26c5e52b104950926b5ef2e23b2c3a` | Potion - Low Poly Medieval, CC0 | Avramania | 494 | bottle/flask variants for `shelf_bottles_*` (same pack as the lantern/crate we already use, so style-consistent; recolour via material) |
| B2 | `3899142ec92c46059d35fc0fa1a0bd41` | Rug - Low Poly Medieval, CC0 | Avramania | 532 | `rug_6x4`, `rug_4x3` (check UV; may be plain) |
| B3 | `3deb43fe85ea43248cae8ed12837ea4e` | Sack - Low Poly Medieval, CC0 | Avramania | 1529 | `shelf_goods` (sacks); `7db2a14529fd4e1f9391c68337f71eac` Grain Sack is 938 |
| B4 | `712b7db004ce488c98c7db9d7f128235` | Curtain - Low Poly Medieval, CC0 | Avramania | 372 | cloth hangings / doorway drape |
| B5 | `9cd0c6d36336456e86c2a79e968e47b6` | Roll - Low Poly Medieval, CC0 | Avramania | 190 | rolled/folded cloth for `shelf_goods` |
| B6 | `aef0f7e9add24013acd7c7d9867d800d` | Basket - Low Poly Medieval, CC0 | Avramania | 2200 | baskets (Fruit Basket 3646) |
| B7 | `6f619f25f5454455b9d86873160937aa` / `fa90afdde3e541458de26d42e1323d7d` | Pot - Low Poly Medieval, CC0 | Avramania | 680 / 339 | ceramic goods |
| B8 | `00f39dec1fd04267a0f74d4291fd5a55` | Candle | Avramania | 430 | table candles |
| B9 | `106f04b6ba564ed6b1441007251d716a` | Scales | Avramania | 686 | `shop_counter` prop |
| B10 | `bd0ad320c35249b9b1a37e2adc061bb9` | Table | Avramania | 464 | `display_table_*` |
| B11 | `cf106afa602b4a6ca6cca454196656ad` | Shelf | Avramania | 72 | shelf carcass |
| B12 | `3edbe61c816b4acca6913fb404639cf5` | Medieval Firepalce - Galway City | Galway3D_DH_AGe | 16156 | `fireplace` (scan-ish, heavy; probably skip) |
Full Avramania pack (all CC0, 60+ items) is listed by searching "Low Poly Medieval, CC0".

CC-BY (credit `author` + title + link in ASSETS.md):
| # | uid | name | author | faces | replaces |
|---|---|---|---|---|---|
| B13 | `98ffcad6a45c4a71922227bf0005590e` | Low poly Pack Alcohol bottles | DaengNu | 2048 pack | **`shelf_bottles_a/b/c`**: best fit, several bottle shapes, ~250 tris each |
| B14 | `99999f032f624e8cb05651f041dbf8eb` | Whiskey and Wine Low-Poly Bottles | Helyeouka | 1926 pack | `shelf_bottles_*` (wine/whisky) |
| B15 | `97789b2180ca4c9692368f7534fe7638` | Bottle Old wine | VITALIY MARUSEV | 576 | single old wine bottle (decimate to 300) |
| B16 | `0b0ffbbb5c454bb7879c6f476d3c009b` | Old Fantasy Potions | Muko_Art | 2272 pack | jars/flasks for apothecary/tea jars |
| B17 | `c3cdfd62aff944e3ae761098db5d3af2` / `c4ca0de729654551b75d9358485b1e4e` | "CC0 - Tin Can 4" / "Tin Can Box" (actually CC-BY) | plaggy | 1820 / 3456 | tins in `shelf_bottles_c`, boxed goods |
| B18 | `d0153e62dfbb4659b0cb55d5bf51a9d1` / `0783e48c8c71463582f4e0a4535aef9a` | Wicker basket 01 / Wicker Basket Pack | koss2712 | 2376 / 3680 | `shelf_goods` baskets |
| B19 | `90e8651994e54ea2ab6afa442962595e` | Low-Poly PSX Style Vintage Rugs Pack | Icevanilla | 360 pack | `rug_*` (PSX low-res texture; may look crude) |
| B20 | `08fee343183d4287a9ac8269ec4e97c5` | Old Persian Carpet | Mehdi Shahsavan | 2732 | `rug_6x4` (best bazaar look, heavier) |
| B21 | `8ab8caf90a0b4d47ac2dc7911febfa66` | Victorian Armchair | Graham | 1056 | `armchair_blue/red` |
| B22 | `ae47fb3d061045569f1089aaabd840ca` | old_leather_armchair | VoGAn | 1928 | `armchair_*` (library/cafe) |
| B23 | `c7b7999b5c3d425bae23e74b669e97d6` | Victorian Lounge Sofa | Jamie McFarlane | 4436 | `sofa_3` |
| B24 | `d1473f5f384a411f979b99214de9f2a9` | Fireplace Low-poly | MaX3Dd | 368 | `fireplace` (cheap; also `081def60...` Fireplace, filthycent, 440) |
| B25 | `33eb258d9873435690254cfbb0ea46ec` | Floor Lamp | bilgehan.korkmaz | 3732 | `floor_lamp` |
| B26 | `2a75286422e64948b1d6626bc9c6d47d` | PICTURE FRAME 15*20 | Fred Drabble | 194 | `frames_wall` (cheap; Victorian frames by Jamie McFarlane 1158-1648) |
| B27 | `87562962d47e48b28cc1b874fa46a47f` / `119e19154a6e40429c47449b7b1e2717` | Cash Register | wasabicats / nathanielmoore | 200 / 1048 | `shop_counter` till (PH CashRegister_01 is already local; only if you want a variant) |
| B28 | `f993239d99304992aef9701af1f31a3c` | Japanese Paper Lantern | WIsEman_Tavern | 800 | hanging lanterns (tea house) |
| B29 | `1bdbe7ea2e5242948f6cd7cccfd7206e` | Metal hanging lantern | Qwert Models | 1460 | hanging lanterns (bazaar) |
| B30 | `c8eafb62343b4d258f0480af923f3e91` | Arabian Hanging Lamps | cha | 13374 | bazaar lamps: very fitting style, needs splitting/decimating to individual lamps |
| B31 | `9b087673052446299e6decda222a42da` | Old Soviet teapot | Amagitsune | 1971 | tea sets (also `99c0bcbb...` Japanese Tea Set, Geraldo Pratama, 9566) |
| B32 | `3f0da232c28d4825a5037f82a7ba6aee` | Chalkboard menu stand | sdonyxz | 456 | `menu_board` |
| B33 | `c6ca6667fd7d4381bd184874dcf44075` | Stack Of Old Books | Arjun Perayil | 876 | `shelf_goods` books (also Medieval Book Stack 2968) |
| B34 | `c2509f5213f84197ae00ab058877e5fc` | Low poly bar table and booths set | anDDDres | 7620 | `booth_2m`, bar counters; needs splitting (low confidence) |

## Not found
- Counter / shop counter: no usable low-poly CC0/CC-BY hit (`Counter` by gorzi is 7942 tris, unjudged style). Keep procedural counters + PH props on top.
- Booth seating: only B34 (set, not verified). Keep procedural `booth_2m` or retexture `chinese_sofa`.
- Folded cloth / fabric bolts: nothing good; B5 Roll and B4 Curtain are the closest CC0 stand-ins.
- Any PH bottle/jar/tin at <=300 tris: none exist.

## Best 8 picks
1. B13 DaengNu alcohol bottle pack (CC-BY) -> `shelf_bottles_a/b/c`; split, <=300 tris each.
2. B1 Avramania Potion (CC0, 494) -> bottle variants / second shape, same style as existing Avramania assets.
3. PH `chinese_sofa` (CC0, 704) -> `sofa_3`.
4. PH `chinese_armchair` (CC0, 2675) -> `armchair_blue/red`.
5. B2 Avramania Rug (CC0, 532) or B20 Old Persian Carpet (CC-BY, 2732) -> `rug_*`.
6. PH `painted_wooden_shelves` (CC0, 524) + B5/B3/B6/B18 props -> `shelf_goods_*`.
7. B24 Fireplace Low-poly (CC-BY, 368) -> `fireplace`.
8. PH `hanging_picture_frame_01` / `fancy_picture_frame_01` (CC0) + PH `standing_chalkboard_01` -> `frames_wall`, `menu_board`.
Also strong: B28/B29 lanterns, B31 teapot, PH `chinese_tea_table`.
