"""Search Sketchfab for downloadable CC0 models (public search, no token needed).
usage: python3 search_sketchfab.py "street lamp" [max_faces=4000] [n=8]
Prints uid / faces / author / url. Pick uids, then: SKETCHFAB_TOKEN=... python3 fetch_sketchfab.py name=uid"""
import json, sys, urllib.parse, urllib.request
q = sys.argv[1]; maxf = int(sys.argv[2]) if len(sys.argv) > 2 else 4000; n = int(sys.argv[3]) if len(sys.argv) > 3 else 8
p = urllib.parse.urlencode({"type": "models", "q": q, "downloadable": "true", "count": 24, "sort_by": "-likeCount"})
req = urllib.request.Request(f"https://api.sketchfab.com/v3/search?{p}", headers={"User-Agent": "aiverse-city3-builder/1.0"})
res = []; url = req.full_url   # server-side licenses/max_face_count filters return almost nothing -> page results, filter licence+faces here
for _ in range(8):
    d = json.load(urllib.request.urlopen(urllib.request.Request(url, headers=req.headers), timeout=60)); res += [m for m in d["results"] if "CC0" in ((m.get("license") or {}).get("label") or "")]
    url = d.get("next")
    if not url or len(res) >= 40: break
for m in [m for m in res if (m.get("faceCount") or 10**9) <= maxf][:n]:
    print(m["uid"], m.get("faceCount"), m["user"]["displayName"], "|", m["name"], "|", m["viewerUrl"])
