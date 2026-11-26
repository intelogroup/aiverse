#!/usr/bin/env python3
"""Where City 3 assets may legally come from, and which of those a script can fetch.

    python3 tools/city3/sources.py list
    python3 tools/city3/sources.py find "market stall"
    python3 tools/city3/sources.py get sketchfab:stall1of4=<uid>
    python3 tools/city3/sources.py get polyhaven:wooden_crate_01
    python3 tools/city3/sources.py credit <asset> <url> <license>

`list` is the honest part: a source is `api` only if a script here can download it
today without a human in the loop. Everything else records the reason, so the next
person does not spend an hour discovering that CGTrader answers with a Cloudflare
challenge or that Fab needs an Epic login plus a per-asset EULA click.

Licences accepted by this project: CC0 preferred; CC-BY allowed when the credit
lands in out/asset-credits.json and tools/city3/ASSETS.md in the same commit.
Anything "non-commercial" or "editorial" is refused -- City 3 ships commercially.
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DOWNLOADS = os.path.expanduser("~/Developer/city3-downloads")
CREDITS = f"{HERE}/out/asset-credits.json"
ALLOWED = {"cc0", "by"}          # CC0, CC-BY: the licence slugs Sketchfab/Fab use

# name -> dict(url, kind, licence, auto, why)
SOURCES = {
    "polyhaven": {
        "url": "https://polyhaven.com/models", "kind": "models+textures",
        "licence": "CC0", "auto": "api",
        "why": "api.polyhaven.com, no key, gltf/bin/include map; 522 models.",
    },
    "sketchfab": {
        "url": "https://sketchfab.com", "kind": "models",
        "licence": "CC0 / CC-BY", "auto": "api",
        "why": "v3 search + download needs SKETCHFAB_API_KEY (present in ~/.zshrc here); "
               "assets/fetch_sketchfab_any.py records licence and author.",
    },
    "ambientcg": {
        "url": "https://ambientcg.com", "kind": "materials",
        "licence": "CC0", "auto": "api",
        "why": "ambientcg.com/api/v2/full_json, no key. Materials only, no meshes.",
    },
    "polyhaven-tex": {
        "url": "https://polyhaven.com/textures", "kind": "materials",
        "licence": "CC0", "auto": "api",
        "why": "same api, t=textures.",
    },
    "cgbookcase": {
        "url": "https://www.cgbookcase.com", "kind": "materials",
        "licence": "CC0", "auto": "scrape",
        "why": "public CC0 texture library with direct links; HTML only, no api.",
    },
    "blenderkit": {
        "url": "https://www.blenderkit.com", "kind": "models+materials",
        "licence": "CC0 (free tier)", "auto": "search-only",
        "why": "search api is open but the download url needs an addon OAuth token; "
               "no BLENDERKIT_API_KEY on this box, and the 'market stall' query "
               "returned only a paid asset.",
    },
    "kenney": {
        "url": "https://kenney.nl/assets", "kind": "kits",
        "licence": "CC0", "auto": "manual",
        "why": "kenney.nl answers 403 to scripted GET (Cloudflare); itch mirrors want a "
               "browser session. Download by hand, then drop into assets/.",
    },
    "quaternius": {
        "url": "https://quaternius.com", "kind": "kits",
        "licence": "CC0", "auto": "manual",
        "why": "site reachable, but pack downloads are Google-Drive/itch redirects.",
    },
    "blendswap": {
        "url": "https://blendswap.com", "kind": "models",
        "licence": "CC0 / CC-BY", "auto": "manual",
        "why": "requires a logged-in account; browse answers 404 to anonymous GET.",
    },
    "cgtrader": {
        "url": "https://www.cgtrader.com/free-3d-models", "kind": "models",
        "licence": "mixed (free tier)", "auto": "manual",
        "why": "answers 202 with a Cloudflare challenge and the ToS forbids automated "
               "downloads; many 'free' items are non-commercial only.",
    },
    "fab": {
        "url": "https://fab.com", "kind": "models+materials",
        "licence": "CC0 (Quixel) / Fab Standard", "auto": "manual",
        "why": "Epic login plus per-asset EULA acceptance, no public download api. This "
               "is where the old Quixel Megascans CC0 library lives now.",
    },
}

UA = {"User-Agent": "aiverse-city3-builder/1.0 (+asset sourcing)"}


def get(url, headers=None, timeout=120):
    req = urllib.request.Request(url, headers={**UA, **(headers or {})})
    return urllib.request.urlopen(req, timeout=timeout)


def jget(url, headers=None, timeout=60):
    return json.load(get(url, headers, timeout))


def sketchfab_token():
    tok = os.environ.get("SKETCHFAB_TOKEN")
    if tok:
        return tok
    zshrc = os.path.expanduser("~/.zshrc")
    if os.path.exists(zshrc):
        m = re.search(r'SKETCHFAB_API_KEY="([^"]+)"', open(zshrc).read())
        if m:
            return m.group(1)
    return None


# ---------------------------------------------------------------- polyhaven
def polyhaven_assets(kind="models", query=None):
    out = jget(f"https://api.polyhaven.com/assets?t={kind}")
    if query:
        q = query.lower()
        out = {k: v for k, v in out.items()
               if q in k.lower() or q in (v.get("name") or "").lower()}
    return out


def polyhaven_files(asset):
    return jget(f"https://api.polyhaven.com/files/{asset}")


def polyhaven_get(asset, out_dir, res="1k", fmt="gltf"):
    """Download a PolyHaven model: gltf + bin + every file in its include map."""
    files = polyhaven_files(asset)[fmt][res]
    os.makedirs(out_dir, exist_ok=True)
    todo = [(files["gltf"]["url"], "model.gltf")]
    if "bin" in files:
        todo.append((files["bin"]["url"], "model.bin"))
    for rel, meta in (files.get("include") or {}).items():
        todo.append((meta["url"], rel.split("/")[-1]))
    for url, name in todo:
        with open(os.path.join(out_dir, name), "wb") as f:
            f.write(get(url).read())
    p = os.path.join(out_dir, "model.gltf")
    doc = json.load(open(p))
    for buf in doc.get("buffers", []):
        if buf.get("uri") and not buf["uri"].startswith("data:"):
            buf["uri"] = "model.bin"
    json.dump(doc, open(p, "w"))
    return p


# ---------------------------------------------------------------- sketchfab
def sketchfab_search(query, downloadables=True, max_n=8):
    tok = sketchfab_token()
    if not tok:
        raise SystemExit("no Sketchfab token: set SKETCHFAB_TOKEN or SKETCHFAB_API_KEY")
    p = {"type": "models", "q": query, "count": str(max_n), "sort_by": "-likeCount"}
    if downloadables:
        p["downloadable"] = "true"
    d = jget("https://api.sketchfab.com/v3/search?" + urllib.parse.urlencode(p),
             {"Authorization": f"Token {tok}"})
    rows = []
    for r in d.get("results", []):
        info = jget(f"https://api.sketchfab.com/v3/models/{r['uid']}",
                    {"Authorization": f"Token {tok}"})
        lic = (info.get("license") or {}).get("slug")
        rows.append({"uid": r["uid"], "name": r["name"], "faces": info.get("faceCount"),
                     "licence": lic, "downloadable": info.get("isDownloadable"),
                     "author": (info.get("user") or {}).get("displayName"),
                     "url": info.get("viewerUrl") if isinstance(info.get("viewerUrl"), str) else ""})
    return rows


# ---------------------------------------------------------------- the rest
def ambientcg_search(query, limit=10):
    d = jget("https://ambientcg.com/api/v2/full_json?type=Material"
             f"&q={urllib.parse.quote(query)}&limit={limit}&include=downloadData")
    return [(a["assetId"], a.get("displayName")) for a in d.get("foundAssets", [])]


def cgbookcase_catalog():
    html = get("https://www.cgbookcase.com/textures").read().decode("utf-8", "replace")
    return sorted(set(re.findall(r'href="(/textures/[a-z0-9\-]+)"', html)))


def credit(asset, url, licence):
    rows = json.load(open(CREDITS)) if os.path.exists(CREDITS) else []
    rows = [r for r in rows if r.get("asset") != asset]
    rows.append({"asset": asset, "source": url, "license": licence})
    rows.sort(key=lambda r: r["asset"])
    json.dump(rows, open(CREDITS, "w"), indent=1)
    print(f"credited {asset}: {licence} {url}")


def main(argv):
    if not argv or argv[0] in ("list", "-h", "--help"):
        for k, v in SOURCES.items():
            print(f"{k:13s} {v['auto']:12s} {v['licence']:22s} {v['url']}")
            print(f"{'':13s} {v['why']}")
        return 0
    cmd = argv[0]
    if cmd == "find":
        q = argv[1]
        print(f"sketchfab (needs a licence check per row):")
        for r in sketchfab_search(q):
            bad = "" if r["licence"] in ALLOWED else "  <-- REFUSED LICENCE"
            print(f"  {r['uid']}  {r['name'][:42]:42s} {r['faces'] or 0:>7} faces  "
                  f"{r['licence']}{bad}  {r['author']}")
        print("polyhaven:", " ".join(polyhaven_assets("models", q) or ["(none)"]))
        print("ambientcg:", " ".join(a for a, _ in ambientcg_search(q)) or "(none)")
        return 0
    if cmd == "get":
        spec = argv[1]
        if spec.startswith("polyhaven:"):
            asset = spec.split(":", 1)[1]
            return print(polyhaven_get(asset, os.path.join(DOWNLOADS,
                                                           "polyhaven-models", asset))) or 0
        if spec.startswith("sketchfab:"):
            args = spec.split(":", 1)[1].split()
            return os.system(f"cd {HERE}/assets && OUT={DOWNLOADS}/sketchfab python3 "
                             f"fetch_sketchfab_any.py {' '.join(args)}")
        raise SystemExit("spec must be polyhaven:<id> or sketchfab:<key>=<uid>")
    if cmd == "credit":
        return credit(*argv[1:4]) or 0
    raise SystemExit(f"unknown command {cmd}")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

