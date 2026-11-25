"""One labelled contact sheet from preview_multi.py output:
    python3 sheet.py <outdir> [sheet.png] [--against <otherdir>]
Flattens the RGBA views onto the preview sky, labels each with its measured fill and
centring, and prints the same numbers. Also prints a per-view RMS delta when --against is
given (before/after iteration). Needs PIL: system python3, NOT Blender's -- Blender ships
numpy but no PIL, the same split plan_img.py already uses.
-> <outdir>/sheet.png   (or the path given); exit 1 if every view is empty."""
import json, os, sys
from PIL import Image, ImageChops, ImageDraw, ImageFont
import numpy as np

SKY = (int(0.62 * 255), int(0.74 * 255), int(0.90 * 255))
ORDER = ["front", "back", "left", "right", "threequarter", "closeup", "structural", "top"]
PAD, HEAD, BAR = 8, 52, 26


def die(msg):
    print("FAIL", msg); sys.exit(1)


def flatten(rgba):
    im = Image.new("RGB", rgba.size, SKY)
    im.paste(rgba, (0, 0), rgba)
    return im


def stats(rgba):
    """Coverage / centring / clipping straight from the alpha channel."""
    al = np.asarray(rgba)[..., 3]
    h, w = al.shape
    m = al > 10
    if not m.any():
        return None
    ys, xs = np.where(m)
    return dict(coverage=float(m.mean()), h=float((ys.max() - ys.min() + 1) / h),
                w=float((xs.max() - xs.min() + 1) / w),
                cx=float((xs.min() + xs.max()) / 2 / w - 0.5),
                cy=float((ys.min() + ys.max()) / 2 / h - 0.5),
                clip=any((xs.min() <= 1, xs.max() >= w - 2, ys.min() <= 1, ys.max() >= h - 2)))


def collect(d):
    """-> [(name, RGB, stats)], ordered, only real views that exist.

    `_cal.png` is an internal calibration scratch file and must never become a tile.
    """
    out = []
    for nm in ORDER:
        p = os.path.join(d, f"view_{nm}.png")
        if not os.path.exists(p):
            continue
        rgba = Image.open(p).convert("RGBA")
        out.append((nm, flatten(rgba), stats(rgba)))
    return out


def font(sz, bold=False):
    for f in ("/System/Library/Fonts/Supplemental/Arial%s.ttf" % (" Bold" if bold else ""),
              "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(f, sz)
        except OSError:
            continue
    return ImageFont.load_default()
def blit(dr, sheet, tiles, x0, y0, tw, th, title):
    """Draw one titled block of tiles; returns the y coordinate below it."""
    if title:
        dr.text((x0, y0), title, font=font(20, True), fill=(240, 240, 245))
        y0 += 26
    for i, (nm, im, st) in enumerate(tiles):
        c, r = i % 4, i // 4
        x = x0 + c * (tw + PAD)
        y = y0 + r * (th + BAR + PAD)
        if im.size != (tw, th):
            im = im.resize((tw, th))
        sheet.paste(im, (x, y))
        dr.rectangle([x, y, x + tw - 1, y + th - 1], outline=(70, 70, 80))
        dr.text((x + 6, y + th + 4), nm.upper(), font=font(15), fill=(235, 235, 240))
        if st:
            s = "fill %d%%  c %+.1f%%,%+.1f%%%s" % (st["h"] * 100, st["cx"] * 100,
                                                    st["cy"] * 100, "  CROP" if st["clip"] else "")
            dr.text((x + tw - 6, y + th + 5), s, font=font(13), fill=(150, 200, 235), anchor="ra")
    rows = (len(tiles) + 3) // 4
    return y0 + rows * (th + BAR + PAD)


def table(tiles, head):
    print("\n%s" % head)
    print("  %-13s %7s %7s %8s %8s %6s" % ("view", "fill", "cover", "centre_x", "centre_y", "clip"))
    for nm, _, st in tiles:
        if not st:
            print("  %-13s %7s" % (nm, "EMPTY")); continue
        print("  %-13s %6.1f%% %6.1f%% %+7.2f%% %+7.2f%% %6s"
              % (nm, st["h"] * 100, st["coverage"] * 100, st["cx"] * 100, st["cy"] * 100,
                 "yes" if st["clip"] else "-"))


def rms(a, b):
    d = np.asarray(ImageChops.difference(a, b), dtype=np.float32)
    return float(np.sqrt((d ** 2).mean()))


def main():
    args = [x for x in sys.argv[1:] if not x.startswith("--")]
    against = None
    if "--against" in sys.argv:
        against = sys.argv[sys.argv.index("--against") + 1]
        args = [x for x in args if x != against]
    if not args:
        die("usage: python3 sheet.py <outdir> [sheet.png] [--against <otherdir>]")
    d = args[0]
    doc = {}
    jp = os.path.join(d, "preview.json")
    if os.path.exists(jp):
        doc = json.load(open(jp))
    tiles = collect(d)
    if not tiles:
        die("no view_*.png in " + d)
    if all(t[2] is None for t in tiles):
        die("every view is empty in " + d)

    tw, th = tiles[0][1].size
    old = collect(against) if against else []
    oldmap = {n: im for n, im, _ in old}

    blocks = [(old, "BEFORE  " + against)] if old else []
    blocks.append((tiles, "AFTER  " + d if old else ""))
    body = sum(len(b[0]) and ((len(b[0]) + 3) // 4) * (th + BAR + PAD) + 26 for b in blocks)
    W = 4 * tw + 5 * PAD
    H = HEAD + PAD + body + PAD
    sheet = Image.new("RGB", (W, H), (18, 18, 22))
    dr = ImageDraw.Draw(sheet)

    cens = doc.get("census", {})
    stem = os.path.splitext(os.path.basename(os.path.abspath(d)))[0]
    dr.text((PAD + 4, 9), stem, font=font(24, True), fill=(240, 240, 245))
    bits = []
    for k in ("objects", "meshes", "verts", "polys", "materials", "bones", "actions"):
        if cens.get(k):
            bits.append("%s %s" % (k, format(cens[k], ",")))
    if doc.get("dims"):
        bits.append("dims %.2f x %.2f x %.2f m" % tuple(doc["dims"]))
    if doc.get("calibration"):
        bits.append("fit %.2f in %d iters" % (doc["calibration"]["ortho_scale"],
                                              doc["calibration"]["iterations"]))
    if bits:
        dr.text((PAD + 4, 33), "   |   ".join(bits), font=font(13), fill=(150, 200, 235))

    y = HEAD + PAD
    for blk, title in blocks:
        y = blit(dr, sheet, blk, PAD, y, tw, th, title) + PAD

    outp = next((x for x in args[1:] if x.endswith(".png")), os.path.join(d, "sheet.png"))
    sheet.save(outp)
    table(tiles, "measured (alpha silhouette)")
    if old:
        print("\nRMS delta vs %s (0 = identical, 255 = opposite)" % against)
        for nm, im, _ in tiles:
            if nm in oldmap:
                print("  %-13s %6.2f" % (nm, rms(im, oldmap[nm])))
            else:
                print("  %-13s %6s" % (nm, "new"))
    print("\nSHEET", outp, sheet.size, os.path.getsize(outp), "bytes,", len(tiles), "views")
    print("FAILED" if all(t[2] is None for t in tiles) else "ALL OK", 0, "failures")


if __name__ == "__main__":
    main()

