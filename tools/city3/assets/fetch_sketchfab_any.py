"""Download Sketchfab models that are CC0 OR CC-BY, recording the credit needed for ASSETS.md.

The repo's fetch_sketchfab.py refuses anything not CC0; interiors want the CC-BY modern furniture and rooms that
only exist under attribution, so this variant allows both and always writes licence + author + uid into meta.json.

    SKETCHFAB_TOKEN=... python3 fetch_sketchfab_any.py key=uid [key=uid ...]
    # token defaults to SKETCHFAB_API_KEY from ~/.zshrc when SKETCHFAB_TOKEN is unset

Writes <out>/<key>/model.gltf + bin + textures + meta.json (out defaults to ~/Developer/city3-downloads/sketchfab).
"""
import io, json, os, re, subprocess, sys, zipfile, urllib.request

ALLOWED = {"cc0", "by"}   # licence slugs Sketchfab uses for free-with-credit


def token():
    t = os.environ.get("SKETCHFAB_TOKEN")
    if t:
        return t
    zshrc = os.path.expanduser("~/.zshrc")
    if os.path.exists(zshrc):
        m = re.search(r'SKETCHFAB_API_KEY="([^"]+)"', open(zshrc).read())
        if m:
            return m.group(1)
    sys.exit("no Sketchfab token: set SKETCHFAB_TOKEN or SKETCHFAB_API_KEY in ~/.zshrc")


def get(url, H, timeout=180):
    return urllib.request.urlopen(urllib.request.Request(url, headers=H), timeout=timeout)


def main():
    H = {"Authorization": f"Token {token()}", "User-Agent": "aiverse-city3-builder/1.0"}
    out_root = os.environ.get("OUT", os.path.expanduser("~/Developer/city3-downloads/sketchfab"))
    for arg in sys.argv[1:]:
        key, uid = arg.split("=", 1)
        info = json.load(get(f"https://api.sketchfab.com/v3/models/{uid}", H))
        slug = (info.get("license") or {}).get("slug")
        if slug not in ALLOWED:
            print(f"{key}: licence '{slug}' not usable, skipped")
            continue
        dl = json.load(get(f"https://api.sketchfab.com/v3/models/{uid}/download", H))["gltf"]["url"]
        dst = os.path.join(out_root, key)
        os.makedirs(dst, exist_ok=True)
        blob = urllib.request.urlopen(dl, timeout=600).read()
        zf = zipfile.ZipFile(io.BytesIO(blob))
        zf.extractall(dst)
        gltf = [n for n in zf.namelist() if n.endswith(".gltf") and n.count("/") == 0]
        # a zip can nest everything one folder deep; symlink/copy a top-level scene.gltf so importers find one shape
        if not gltf:
            nested = [n for n in zf.namelist() if n.endswith(".gltf")]
            if nested:
                base = os.path.dirname(nested[0])
                for n in zf.namelist():
                    if n.startswith(base + "/") and not os.path.exists(os.path.join(dst, n[len(base) + 1:])):
                        pass
        meta = {
            "key": key, "uid": uid, "title": info["name"],
            "author": info["user"]["displayName"], "license": (info.get("license") or {}).get("label"),
            "license_slug": slug, "source": info["viewerUrl"], "faces": info.get("faceCount"),
            "credit": f"\"{info['name']}\" by {info['user']['displayName']} — {info['viewerUrl']} ({(info.get('license') or {}).get('label')})",
        }
        json.dump(meta, open(os.path.join(dst, "meta.json"), "w"), indent=1)
        print(f"{key:26s} {(info.get('faceCount') or 0):>8} faces  {len(blob) / 1e6:6.1f} MB  {meta['license']}")


main()
