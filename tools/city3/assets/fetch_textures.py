"""Download Poly Haven CC0 PBR textures (diffuse + GL normal + roughness, 1k jpg) into ptex/<id>/.
usage: python3 fetch_textures.py id [id ...]   (needs a User-Agent; the API 403s without one)"""
import json, os, sys, urllib.request
UA = {"User-Agent": "aiverse-city3-builder/1.0"}
def get(url): return urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90)
for i in sys.argv[1:]:
    f = json.load(get(f"https://api.polyhaven.com/files/{i}")); info = json.load(get(f"https://api.polyhaven.com/info/{i}"))
    os.makedirs(f"ptex/{i}", exist_ok=True)
    for key, tag in (("Diffuse", "d"), ("nor_gl", "n"), ("Rough", "r")):
        url = f[key]["1k"]["jpg"]["url"]; p = f"ptex/{i}/{tag}.jpg"
        if not os.path.exists(p): open(p, "wb").write(get(url).read())
    dim = info.get("dimensions") or [1000, 1000]
    json.dump({"id": i, "name": info.get("name"), "authors": info.get("authors"), "license": "CC0", "source": f"https://polyhaven.com/a/{i}",
               "size_m": [round(dim[0] / 1000, 3), round(dim[1] / 1000, 3)]}, open(f"ptex/{i}/meta.json", "w"))
    print(f"{i:34s} tile {dim[0]/1000:.2f} x {dim[1]/1000:.2f} m")
