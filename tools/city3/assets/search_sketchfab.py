"""Search Sketchfab for downloadable CC0 models (public search, no token needed).
usage: python3 search_sketchfab.py "street lamp" [max_faces=4000] [n=8]
Prints uid / faces / author / url. Pick uids, then: SKETCHFAB_TOKEN=... python3 fetch_sketchfab.py name=uid"""
import json, sys, urllib.parse, urllib.request
q = sys.argv[1]; maxf = int(sys.argv[2]) if len(sys.argv) > 2 else 4000; n = int(sys.argv[3]) if len(sys.argv) > 3 else 8
p = urllib.parse.urlencode({"type": "models", "q": q, "licenses": "cc0", "downloadable": "true",
                            "max_face_count": maxf, "count": n, "sort_by": "-likeCount"})
req = urllib.request.Request(f"https://api.sketchfab.com/v3/search?{p}", headers={"User-Agent": "aiverse-city3-builder/1.0"})
for m in json.load(urllib.request.urlopen(req, timeout=60))["results"]:
    print(m["uid"], m.get("faceCount"), m["user"]["displayName"], "|", m["name"], "|", m["viewerUrl"])
