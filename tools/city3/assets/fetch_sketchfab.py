"""Download CC0 Sketchfab models as glTF. Token from env SKETCHFAB_TOKEN (never committed).
usage: SKETCHFAB_TOKEN=... python3 fetch_sketchfab.py name=uid [name=uid ...]   -> sketchfab/<name>/ (+ meta.json credit)"""
import json, os, sys, urllib.request, zipfile, io
T = os.environ["SKETCHFAB_TOKEN"]; H = {"Authorization": f"Token {T}", "User-Agent": "aiverse-city3-builder/1.0"}
def get(u): return urllib.request.urlopen(urllib.request.Request(u, headers=H), timeout=90)
for a in sys.argv[1:]:
    name, uid = a.split("=")
    info = json.load(get(f"https://api.sketchfab.com/v3/models/{uid}"))
    if (info.get("license") or {}).get("slug") != "cc0": print(name, "NOT CC0 - skipped"); continue
    dl = json.load(get(f"https://api.sketchfab.com/v3/models/{uid}/download"))["gltf"]["url"]
    d = f"sketchfab/{name}"; os.makedirs(d, exist_ok=True)
    zipfile.ZipFile(io.BytesIO(urllib.request.urlopen(dl, timeout=120).read())).extractall(d)
    json.dump({"name": name, "uid": uid, "title": info["name"], "author": info["user"]["displayName"], "license": "CC0", "source": info["viewerUrl"], "faces": info.get("faceCount")}, open(f"{d}/meta.json", "w"))
    print(name, "ok", info["name"], info.get("faceCount"))
