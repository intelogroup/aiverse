import json, urllib.request
def post(path, body, timeout=720):
    req = urllib.request.Request("http://127.0.0.1:5317"+path, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r: return json.loads(r.read())
mv = post("/move", {"agentId":"probe","position":[-26.6,-64.2],"mode":"run"})
print("vantage1:", mv.get("outcomes"), mv["pose"]["pos"], flush=True)
print("PROBE2 DONE", flush=True)
