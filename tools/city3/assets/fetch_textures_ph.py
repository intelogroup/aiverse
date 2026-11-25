"""Fetch Poly Haven CC0 texture sets (diffuse + normal + roughness + AO) at a chosen resolution.

    python3 fetch_textures_ph.py --res 2k --out ~/Developer/city3-downloads/polyhaven-tex herringbone_parquet painted_plaster_wall

Each id lands in <out>/<id>/ as <map>.jpg/.png plus meta.json (name, authors, licence, source), ready for the Blender
material builder to wire into a Principled BSDF.
"""
import argparse, hashlib, json, os, urllib.request

UA = {"User-Agent": "aiverse-city3-builder/1.0"}
WANT = ["Diffuse", "nor_gl", "Rough", "AO"]


def get(url):
    return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=120)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--res", default="2k")
    ap.add_argument("--out", default=os.path.expanduser("~/Developer/city3-downloads/polyhaven-tex"))
    ap.add_argument("ids", nargs="+")
    a = ap.parse_args()

    for tid in a.ids:
        files = json.load(get(f"https://api.polyhaven.com/files/{tid}"))
        info = json.load(get(f"https://api.polyhaven.com/info/{tid}"))
        dst = os.path.join(os.path.expanduser(a.out), tid)
        os.makedirs(dst, exist_ok=True)
        total = 0
        for name in WANT:
            spec = (files.get(name) or {}).get(a.res)
            if not spec:
                continue
            fmt, meta = next(iter(spec.items()))
            ext = "jpg" if fmt == "jpg" else "png"
            path = os.path.join(dst, f"{name.lower()}.{ext}")
            if not os.path.exists(path):
                open(path, "wb").write(get(meta["url"]).read())
            data = open(path, "rb").read()
            total += len(data)
            if meta.get("md5") and hashlib.md5(data).hexdigest() != meta["md5"]:
                print(f"  MD5 MISMATCH {tid}/{name}")
        json.dump({"id": tid, "name": info.get("name"), "authors": info.get("authors"), "license": "CC0",
                   "source": f"https://polyhaven.com/a/{tid}", "res": a.res},
                  open(os.path.join(dst, "meta.json"), "w"), indent=1)
        print(f"{tid:26s} {total // 1024:6d} KB  {a.res}")


main()
