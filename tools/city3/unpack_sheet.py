"""Contact sheet of every image embedded in a GLB -- pure python, no Blender.

    python3 tools/city3/unpack_sheet.py <glb> [out.png] [--cols 12] [--thumb 96]

Why this exists: the world GLBs store most images as image/ktx2, which Blender
cannot decode and PIL cannot decode either. This tool decodes every JPEG/PNG,
draws a labelled tile for every KTX2 with its byte size, and never pretends a
KTX2 was inspected. KTX2 tiles are grey with "KTX2 <KB>" -- an honest gap, not a
guess.

Also reports duplicate payloads by sha1: in a packed kit the same 512px texture
can be embedded once per material, and that is compressible weight.

Exit 1 only when the GLB holds no images at all (nothing to inspect).
"""
import hashlib
import io
import os
import sys

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import glb as G  # noqa: E402

BG = (18, 18, 22)
TILE = (34, 34, 40)
KTX = (70, 60, 46)
TXT = (235, 235, 240)
DIM = (150, 200, 235)


def font(size):
    for f in ("/System/Library/Fonts/Supplemental/Arial.ttf",
              "/System/Library/Fonts/Helvetica.ttc"):
        try:
            return ImageFont.truetype(f, size)
        except OSError:
            continue
    return ImageFont.load_default()


def decode(mime, data):
    """-> PIL image or None. Refuses KTX2 loudly rather than guessing."""
    if mime in ("image/jpeg", "image/png", "image/webp"):
        try:
            im = Image.open(io.BytesIO(data))
            im.load()
            return im.convert("RGB")
        except Exception:
            return None
    if mime == "image/ktx2" or data[:12] == b"\xabKTX 20\xbb\r\n\x1a\n":
        return None
    try:
        return Image.open(io.BytesIO(data)).convert("RGB")
    except Exception:
        return None


def main(argv):
    args = [a for a in argv if not a.startswith("--")]
    cols, thumb = 12, 96
    for a in argv:
        if a.startswith("--cols="):
            cols = int(a[7:])
        elif a.startswith("--thumb="):
            thumb = int(a[8:])
    if not args:
        sys.exit(__doc__)
    src = args[0]
    g = G.load(src)
    imgs = G.images(g)
    if not imgs:
        print(f"FAIL {os.path.basename(src)} has no images")
        sys.exit(1)
    out = args[1] if len(args) > 1 and args[1].endswith(".png") else \
        os.path.splitext(src)[0] + "-sheet.png"

    tiles, seen, dup_bytes, ktx, decoded, failed = [], {}, 0, 0, 0, 0
    biggest = []
    for i, name, mime, data in imgs:
        digest = hashlib.sha1(data).hexdigest() if data else ""
        if digest in seen:
            dup_bytes += len(data)
        else:
            seen[digest] = i
        biggest.append((len(data), i, name, mime))
        im = decode(mime, data) if data else None
        if im is not None:
            decoded += 1
            im.thumbnail((thumb, thumb))
            tiles.append((i, name, mime, im, len(data)))
        elif mime == "image/ktx2" or (data[:12] == b"\xabKTX 20\xbb\r\n\x1a\n"):
            ktx += 1
            tiles.append((i, name, mime, None, len(data)))
        else:
            failed += 1
            tiles.append((i, name, mime or "?", None, len(data)))

    pad, label, head = 6, 30, 46
    rows = (len(tiles) + cols - 1) // cols
    W = cols * (thumb + pad) + pad
    H = head + rows * (thumb + label + pad) + pad
    sheet = Image.new("RGB", (W, H), BG)
    dr = ImageDraw.Draw(sheet)
    stem = os.path.basename(g.path)
    dr.text((pad + 2, 8), f"{stem}  {len(tiles)} images", font=font(18), fill=TXT)
    mimes = {}
    for *_, m, _d in [(i, n, mi, d) for i, n, mi, d in imgs]:
        mimes[m] = mimes.get(m, 0) + 1
    dr.text((pad + 2, 27),
            f"decoded {decoded}  ktx2 {ktx}  failed {failed}  "
            f"duplicate bytes {dup_bytes / 1024:.0f} KB  {mimes}", font=font(12), fill=DIM)

    for n, (i, name, mime, im, nbytes) in enumerate(tiles):
        c, r = n % cols, n // cols
        x, y = pad + c * (thumb + pad), head + r * (thumb + label + pad)
        if im is None:
            dr.rectangle([x, y, x + thumb - 1, y + thumb - 1], fill=KTX)
            tag = "KTX2" if mime == "image/ktx2" or mime.endswith("ktx2") else "?"
            dr.text((x + thumb // 2, y + thumb // 2 - 8), tag, font=font(13),
                    fill=TXT, anchor="mm")
            dr.text((x + thumb // 2, y + thumb // 2 + 8), f"{nbytes // 1024} KB",
                    font=font(10), fill=(200, 190, 170), anchor="mm")
        else:
            ox = x + (thumb - im.width) // 2
            oy = y + (thumb - im.height) // 2
            sheet.paste(im, (ox, oy))
            dr.rectangle([x, y, x + thumb - 1, y + thumb - 1], outline=(70, 70, 80))
        label_txt = (name or f"image_{i}")[:16]
        dr.text((x, y + thumb + 3), label_txt, font=font(10), fill=TXT)
        dr.text((x, y + thumb + 15), f"#{i} {nbytes // 1024}KB", font=font(9), fill=DIM)

    sheet.save(out)
    print(f"IMAGES {len(tiles)}  decoded {decoded}  ktx2 {ktx}  failed {failed}")
    print(f"DUPLICATE payload bytes {dup_bytes / 1024:.1f} KB in {len(imgs) - len(seen)} repeats")
    print("LARGEST:")
    for nbytes, i, name, mime in sorted(biggest, reverse=True)[:5]:
        print(f"  #{i:<4d} {nbytes / 1024:8.1f} KB  {mime:12s} {name}")
    print(f"SHEET {out} {sheet.size} {os.path.getsize(out)} bytes")
    print("ALL OK  0 failures" if failed == 0 else f"FAILED  {failed} undecodable")


if __name__ == "__main__":
    main(sys.argv[1:])
