"""Textures for the modern districts (Glass Quarter, Foundry Wharf, Garden Terraces).
Runs in plain Python (numpy + PIL). Writes tex_m/*.jpg|png, glass_atlas.json, palette_m.json.
 - curtain-wall atlas (8 variants of one floor x three bays) + a matching emissive 'lit windows' atlas
 - modern signage atlas, palette swatch image, resized/tinted copies of the Poly Haven CC0 PBR sets
Texture convention (same as textures.py): arrays are y-up (row 0 = bottom) and flipped when saved."""
import json, os, numpy as np
from PIL import Image, ImageDraw, ImageFont
HERE = os.path.dirname(os.path.abspath(__file__)); OUT = f"{HERE}/tex_m"; os.makedirs(OUT, exist_ok=True)
rng = np.random.default_rng(4242)

def noise(h, w, beta=1.6, seed=None):
    r = np.random.default_rng(seed) if seed is not None else rng
    f = np.fft.fft2(r.standard_normal((h, w))); fy = np.fft.fftfreq(h)[:, None]; fx = np.fft.fftfreq(w)[None, :]
    k = np.sqrt(fx ** 2 + fy ** 2); k[0, 0] = 1; f = f / (k ** beta); f[0, 0] = 0
    n = np.real(np.fft.ifft2(f)); return (n - n.mean()) / (n.std() + 1e-9)
def col(h): h = h.lstrip("#"); return np.array([int(h[i:i + 2], 16) for i in (0, 2, 4)], float)
def save(a, name, flip=True, q=88):
    a = np.clip(a, 0, 255).astype(np.uint8)
    if flip: a = a[::-1]
    Image.fromarray(a).save(f"{OUT}/{name}.jpg", quality=q)

# ---------------------------------------------------------------- curtain wall atlas
# One tile = one storey (4.0 m) x three 1.5 m bays (4.5 m); 4 columns x 2 rows of 512 px => 2048x1024.
TW, TH = 512, 512; BAYS = 3; FLOOR_H = 4.0; BAY_W = 1.5; SPAN = 1.0       # spandrel (opaque band) height in metres
VARIANTS = 8
def glass_tile(seed, lit_prob):
    r = np.random.default_rng(seed); ppm_x = TW / (BAYS * BAY_W); ppm_y = TH / FLOOR_H
    img = np.zeros((TH, TW, 3)); em = np.zeros((TH, TW, 3))
    ys = np.arange(TH)[:, None] / ppm_y; xs = np.arange(TW)[None, :] / ppm_x
    spandrel = ys < SPAN
    # sky reflection: dark teal near the floor, lighter toward the head; a drifting cloud band + a reflected-building smear
    g = np.clip((ys - SPAN) / (FLOOR_H - SPAN), 0, 1)
    base = col("#16283a")[None, None, :] * (1 - g[..., None]) + col("#5f8fae")[None, None, :] * g[..., None]
    cloud = noise(TH, TW, 2.2, seed)[..., None]; base = base * (1 + 0.16 * cloud)
    smear = noise(8, TW, 0.8, seed + 7); smear = np.array(Image.fromarray(((smear - smear.min()) / (np.ptp(smear) + 1e-9) * 255).astype(np.uint8)).resize((TW, TH), Image.BICUBIC), float) / 255
    base = base * (0.95 + 0.1 * smear[..., None])
    for _ in range(int(r.integers(2, 5))):                                    # reflected neighbours: hard-edged lighter/darker slabs crossing bays
        x0 = int(r.integers(0, TW - 80)); w = int(r.integers(60, 260)); y0 = int(SPAN * ppm_y); h = int(r.integers(120, TH - y0))
        base[y0:y0 + h, x0:x0 + w] *= r.uniform(0.82, 1.14)
    img[:] = base
    lit_bays = r.random(BAYS) < lit_prob; blind = r.random(BAYS) < 0.2
    for b in range(BAYS):
        x0, x1 = int(b * BAY_W * ppm_x), int((b + 1) * BAY_W * ppm_x)
        sl = (slice(int(SPAN * ppm_y) + 4, TH - 10), slice(x0 + 5, x1 - 5))
        img[sl] *= 0.93 + 0.14 * r.random()                                   # per-bay panel tone
        top = TH - 10 - int(0.26 * ppm_y)                                     # ceiling zone: a touch brighter/warmer inside
        img[top:TH - 10, x0 + 5:x1 - 5] = img[top:TH - 10, x0 + 5:x1 - 5] * 0.55 + col("#b8c4cc") * 0.45
        if blind[b]:
            drop = r.uniform(0.12, 0.5); y_lo = int(TH - 10 - drop * (TH - 10 - (SPAN * ppm_y + 4)))
            reg = (slice(y_lo, TH - 10), slice(x0 + 5, x1 - 5)); sh = np.sin(np.arange(y_lo, TH - 10)[:, None] * 1.6) * 0.04
            img[reg] = img[reg] * 0.35 + (col("#b4ada0")[None, None, :] * (1 + sh[..., None])) * (0.55 + 0.1 * r.random())
        if lit_bays[b]:                                                       # a lit room behind this bay (night map only)
            reg = (slice(int(SPAN * ppm_y) + 6, TH - 12), slice(x0 + 6, x1 - 6)); yy = np.linspace(1.0, 0.55, reg[0].stop - reg[0].start)[:, None, None]
            warm = col(r.choice(["#ffd9a0", "#ffe9c4", "#f5c98a", "#cfe6ff"]))
            em[reg] = warm[None, None, :] * yy * (0.55 if blind[b] else 1.0)
    # frame: mullions every bay, transom at the head and the sill, aluminium cap under the spandrel
    mull = col("#222a30")
    for b in range(BAYS + 1):
        x = int(b * BAY_W * ppm_x); img[:, max(0, x - 3):min(TW, x + 3)] = mull
    img[int(SPAN * ppm_y):int(SPAN * ppm_y) + 4] = mull; img[TH - 10:TH] = mull
    # spandrel panel: dark enamelled glass, faint frit dots
    sp = (slice(0, int(SPAN * ppm_y)), slice(0, TW)); n2 = noise(int(SPAN * ppm_y), TW, 0.9, seed + 3)
    img[sp] = col("#27323a")[None, None, :] * (1 + 0.05 * n2[..., None]); img[int(SPAN * ppm_y) - 3:int(SPAN * ppm_y)] = col("#8e979c")
    for b in range(BAYS + 1):
        x = int(b * BAY_W * ppm_x); img[:int(SPAN * ppm_y), max(0, x - 3):min(TW, x + 3)] = mull
    em[:int(SPAN * ppm_y)] = 0
    return img, em
def build_glass_atlas():
    D = np.zeros((TH * 2, TW * 4, 3)); E = np.zeros_like(D); meta = {}
    for k in range(VARIANTS):
        d, e = glass_tile(900 + k, 0.10 + 0.05 * (k % 3)); c, rw = k % 4, k // 4
        y0, x0 = rw * TH, c * TW; D[y0:y0 + TH, x0:x0 + TW] = d; E[y0:y0 + TH, x0:x0 + TW] = e
        g = 4.0 / TW; meta[str(k)] = [(x0 + 4) / (TW * 4), (y0 + 4) / (TH * 2), (x0 + TW - 4) / (TW * 4), (y0 + TH - 4) / (TH * 2)]
    save(D, "glass_atlas"); save(E, "glass_emit", q=90)
    json.dump({"tiles": meta, "floor_h": FLOOR_H, "bay_w": BAY_W, "bays": BAYS, "span": SPAN}, open(f"{HERE}/glass_atlas.json", "w"))

# ---------------------------------------------------------------- signage atlas (8 tiles, 512x128, y-up rows)
SIGNS = [("NOVA", "#0e1b2c", "#7fd8ff"), ("HELIX BANK", "#f2f2ee", "#0e3b5c"), ("VERTEX", "#1d1d1f", "#ffffff"), ("MERIDIAN", "#0f5f55", "#e8fff8"),
         ("ORBITAL", "#d8402d", "#fff4e8"), ("LUMEN CAFE", "#f4e4c4", "#3a2a1a"), ("PARALLAX", "#26224a", "#c8b8ff"), ("ARCADIA", "#e9ecef", "#1a2a3a"),
         ("KILN & CO", "#2b2623", "#f0b060"), ("ANVIL STUDIOS", "#c9552b", "#1c1411"), ("FOUNDRY BREWERY", "#1e3a2f", "#f4e3b0"), ("COPPER ROW", "#b87333", "#fff3e0"),
         ("SMELTER BAR", "#111111", "#ff7a30"), ("WHARF MARKET", "#e8e0cc", "#27414f"), ("TIN LOFTS", "#9aa5ab", "#16222a"), ("IRONWORKS", "#3a3f44", "#e8e8e8")]
def build_signs():
    W, H = 512, 128; A = Image.new("RGB", (W, H * 16), (0, 0, 0)); d = ImageDraw.Draw(A)
    try: f = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 62); f2 = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 50)
    except Exception: f = f2 = ImageFont.load_default()
    for k, (t, bg, fg) in enumerate(SIGNS):
        y = k * H; d.rectangle([0, y, W, y + H], fill=bg); d.rectangle([5, y + 5, W - 6, y + H - 6], outline=fg, width=2)
        ff = f if len(t) < 8 else f2; d.text((W / 2, y + H / 2), t, fill=fg, font=ff, anchor="mm")
    A.save(f"{OUT}/msigns.jpg", quality=90)                        # image row 0 = top; tile k is rows k*128 from the top -> v from the bottom = 1-(k+1)/8
    json.dump({str(k): [0.0, 1 - (k + 1) / 16 + 0.002, 1.0, 1 - k / 16 - 0.002] for k in range(16)}, open(f"{HERE}/msigns.json", "w"))

# ---------------------------------------------------------------- palette (8x8 swatches of 8 px: 64 colours)
PALM = {  # concrete / metal / glass trims
 "alu":"#b9c0c6","alu_dk":"#5d666d","steel":"#3c4147","black":"#15181b","white":"#f1f1ee","concrete":"#9a9a96","concrete_dk":"#6e6e6b","glass_dk":"#1c2b38",
 "glass_teal":"#2f6c78","glass_lt":"#8db4cc","warm_led":"#ffd9a0","cool_led":"#bfe6ff","red":"#c8372d","orange":"#e8822c","yellow":"#f1c232","teal":"#1f8a8a",
 "blue":"#2d62b8","navy":"#16284d","green":"#4f9a4b","leaf":"#5b9a3c","leaf_dk":"#356b2a","leaf_lt":"#8bbd4f","trunk":"#5a4128","wood":"#a77b4a","wood_dk":"#6e4a2b",
 "soil":"#4a3a2c","grass":"#5e9a45","water":"#2f8fa6","water_dk":"#16556b","sand":"#d6c59a","brick":"#a1503a","brick_dk":"#6d3326","rust":"#9a4a22","paint_yellow":"#e6c229",
 "paint_white":"#ececea","pink":"#e0889a","lilac":"#9a86c9","cream":"#efe5cf","gravel":"#8b8984","bitumen":"#2a2b2d","safety":"#f26a1b","container_red":"#9d3b2c",
 "container_blue":"#2d5f93","container_green":"#3a7a54","container_ochre":"#c98a2b","container_grey":"#8b9299","tile_white":"#e9ebe8","terra":"#c1693f","moss":"#7c8f4a",
}
def build_palette():
    names = list(PALM); assert len(names) <= 64
    img = np.zeros((64, 64, 3)); idx = {}
    for i, n in enumerate(names):
        c, r = i % 8, i // 8; img[r * 8:(r + 1) * 8, c * 8:(c + 1) * 8] = col(PALM[n]); idx[n] = i
    Image.fromarray(img.astype(np.uint8)).save(f"{OUT}/palette_m.png"); json.dump(idx, open(f"{HERE}/palette_m.json", "w"))

# ---------------------------------------------------------------- Poly Haven PBR sets -> 512 px, optionally tinted
PT = f"{HERE}/assets/ptex"
GRAY = {"pave_sq": 0.85, "terrazzo": 0.85, "tile_brown": 0.8, "plaza_herring": 0.3, "panel_conc": 0.55, "cladding_dk": 0.3}
def pbr(pid, tint=None, px=512, tag=None, hue_mul=None):
    """Writes tex_m/<tag>_d.jpg and _n.jpg; returns (tile_size_m, mean_roughness)."""
    tag = tag or pid; meta = json.load(open(f"{PT}/{pid}/meta.json")); size = meta["size_m"][1] or meta["size_m"][0] or 2.0
    d = Image.open(f"{PT}/{pid}/d.jpg").convert("RGB").resize((px, px), Image.LANCZOS); a = np.array(d, float)
    g = GRAY.get(tag, 0.0)
    if g: a = a * (1 - g) + a.mean(axis=2, keepdims=True) * g
    if tint is not None: a = a * (np.array(tint)[None, None, :] if not isinstance(tint, str) else col(tint)[None, None, :] / 255.0 * 2)
    Image.fromarray(np.clip(a, 0, 255).astype(np.uint8)).save(f"{OUT}/{tag}_d.jpg", quality=86)
    Image.open(f"{PT}/{pid}/n.jpg").convert("RGB").resize((px, px), Image.LANCZOS).save(f"{OUT}/{tag}_n.jpg", quality=88)
    r = float(np.array(Image.open(f"{PT}/{pid}/r.jpg").convert("L").resize((64, 64)), float).mean() / 255)
    return dict(size=size, rough=round(r, 3))
# ---------------------------------------------------------------- ambientCG sets -> same tex_m layout
ACG = f"{HERE}/assets/ambientcg"
def acg_pbr(aid, tag, tile_m, px=1024):
    """ambientCG 1K JPG set -> tex_m/<tag>_d.jpg (AO multiplied into the diffuse, as in ambientCG's own
    template material), _n.jpg (NormalGL) and _r.jpg (roughness; wired by pbr_override when present).
    Returns the pbr_m entry: size = the real-world tile the set is proofed at (m), rough = mean roughness."""
    s = f"{ACG}/{aid}"
    ao = np.array(Image.open(f"{s}/{aid}_1K-JPG_AmbientOcclusion.jpg").convert("L").resize((px, px), Image.LANCZOS), float) / 255.0
    d = np.array(Image.open(f"{s}/{aid}_1K-JPG_Color.jpg").convert("RGB").resize((px, px), Image.LANCZOS), float) * ao[..., None]
    Image.fromarray(np.clip(d, 0, 255).astype(np.uint8)).save(f"{OUT}/{tag}_d.jpg", quality=86)
    Image.open(f"{s}/{aid}_1K-JPG_NormalGL.jpg").convert("RGB").resize((px, px), Image.LANCZOS).save(f"{OUT}/{tag}_n.jpg", quality=88)
    # channel-packed companion (glTF metallicRoughness layout): R = AO, G = roughness, B = 0 (metalness).
    # pbr_override wires G/B from this one image, so the exporter ships it verbatim instead of re-combining
    # (a scalar-metal + texture-rough pair gets re-encoded and balloons ~4x). 4:4:4 keeps the channels clean.
    g = np.array(Image.open(f"{s}/{aid}_1K-JPG_Roughness.jpg").convert("L").resize((px, px), Image.LANCZOS), float)
    packed = np.dstack([ao * 255, g, np.zeros_like(g)]).astype(np.uint8)
    Image.fromarray(packed).save(f"{OUT}/{tag}_r.jpg", quality=90, subsampling=0)
    return dict(size=tile_m, rough=round(float(g.mean() / 255), 3))
# ---------------------------------------------------------------- Poly Haven full sets (d/n/r + ARM) -> 1K, packed companion
def ph_pbr(pid, tag, tile_m, px=1024):
    """Poly Haven 1K set from assets/ptex/<pid> (d/n/r.jpg + arm.jpg) -> tex_m/<tag>_d.jpg (AO from the ARM
    red channel multiplied into the diffuse, ambientCG-template style), _n.jpg and _r.jpg — a channel-packed
    companion in glTF metallicRoughness layout (R = AO, G = roughness, B = 0 metalness) that pbr_override
    wires G/B from when present, so the exporter ships it verbatim instead of re-combining. Returns the
    pbr_m entry: size = the tile the set is applied at (m), rough = mean roughness."""
    s = f"{PT}/{pid}"
    d = np.array(Image.open(f"{s}/d.jpg").convert("RGB").resize((px, px), Image.LANCZOS), float)
    g = np.array(Image.open(f"{s}/r.jpg").convert("L").resize((px, px), Image.LANCZOS), float)
    if os.path.exists(f"{s}/arm.jpg"):
        ao = np.array(Image.open(f"{s}/arm.jpg").convert("RGB").resize((px, px), Image.LANCZOS), float)[:, :, 0] / 255.0
    else:
        ao = np.ones((px, px))
    Image.fromarray(np.clip(d * ao[..., None], 0, 255).astype(np.uint8)).save(f"{OUT}/{tag}_d.jpg", quality=86)
    Image.open(f"{s}/n.jpg").convert("RGB").resize((px, px), Image.LANCZOS).save(f"{OUT}/{tag}_n.jpg", quality=88)
    packed = np.dstack([ao * 255, g, np.zeros_like(g)]).astype(np.uint8)
    Image.fromarray(packed).save(f"{OUT}/{tag}_r.jpg", quality=90, subsampling=0)
    return dict(size=tile_m, rough=round(float(g.mean() / 255), 3))
# name -> (poly haven id, tint multiplier or None, px)
SETS = {
 "cladding_dk": ("concrete_tile_facade", None, 512), "ribbed": ("ribbed_concrete_wall", None, 512), "panel_conc": ("brushed_concrete_04", None, 512),
 "tile_dk": ("rectangular_facade_tiles", None, 512), "tile_brown": ("rectangular_facade_tiles_02", None, 512), "plaza_herring": ("herringbone_concrete_tile", None, 512),
 "road_m": ("clean_asphalt", None, 1024), "pave_sq": ("square_concrete_pavers", None, 512), "slab_wall": ("concrete_slab_wall_02", None, 512),
 "metal_red": ("box_profile_metal_sheet", None, 512), "corrugated": ("corrugated_iron_02", None, 512), "brick_blue": ("painted_brick", None, 512),
 "brick_cream": ("plaster_brick_pattern", None, 512), "diamond": ("metal_plate", None, 512), "rust": ("rusty_metal_02", None, 512),
 "factory_green": ("factory_wall", None, 512), "bitumen": ("bitumen", None, 512), "stucco": ("white_stucco_02", (1.28, 1.26, 1.2), 512), "wood_slat": ("wood_inlaid_concrete_wall", None, 512),
 "stone_clad": ("patterned_concrete_wall", None, 512), "terrazzo": ("terrazzo_tiles", None, 512), "roof_grey": ("grey_roof_01", None, 512), "concrete_w5": ("concrete_wall_005", None, 512),
 "pavement": ("concrete_pavement_03", None, 512), "brick_red": ("plaster_brick_pattern", (1.0, 0.52, 0.42), 512), "brick_dark": ("plaster_brick_pattern", (0.55, 0.42, 0.38), 512),
 "cont_red": ("corrugated_iron_02", (1.9, 0.55, 0.45), 512), "cont_blue": ("corrugated_iron_02", (0.55, 0.9, 1.9), 512), "cont_green": ("corrugated_iron_02", (0.6, 1.5, 0.8), 512), "cont_ochre": ("corrugated_iron_02", (1.8, 1.3, 0.5), 512),
 "cobble_pbr": ("cobblestone_04", (1.18, 1.02, 0.84), 1024), "roof_clay": ("clay_roof_tiles_03", (1.1, 0.95, 0.9), 512), "roof_clay2": ("clay_roof_tiles_02", None, 512),
 "pave_warm": ("square_concrete_pavers", (1.15, 0.98, 0.8), 512),
 "plaza_stone": ("herringbone_concrete_tile", (1.22, 1.06, 0.86), 1024),
 "metal_teal": ("box_profile_metal_sheet", (0.25, 2.6, 2.6), 512), "floor_conc": ("concrete_floor_02", None, 512),
}
def build_pbr():
    info = {}
    for tag, (pid, tint, px) in SETS.items(): info[tag] = pbr(pid, tint, px, tag)
    info["plaza_setts"] = acg_pbr("PavingStones150", "plaza_setts", 2.5)   # ambientCG fan setts, proofed tile 2.5 m (Bazaar plaza)
    info["roof_barrel"] = ph_pbr("clay_roof_tiles_02", "roof_barrel", 2.6)   # Poly Haven barrel tile, proofed tile 2.6 m (Bazaar pitched roofs; hall vault at 5.2 m via tile_m 1.5)
    info["grass004"] = acg_pbr("Grass004", "grass004", 2.0)   # ambientCG short grass, tile 2.0 m (Terraces green roofs)
    json.dump(info, open(f"{HERE}/pbr_m.json", "w"), indent=1); return info
if __name__ == "__main__":
    build_glass_atlas(); build_signs(); build_palette(); info = build_pbr()
    print("tex_m:", sorted(os.listdir(OUT))[:6], "...", sum(os.path.getsize(f"{OUT}/{f}") for f in os.listdir(OUT)) // 1024, "KB;", len(info), "PBR sets")
