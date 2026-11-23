#!/usr/bin/env python3
"""Replay video of a recorded Verse scene, as the visitor's OWNER would experience it.

  render-replay.py prepare <scenario_dir> <items.json>             -> the lines to synthesize (console rules, order of arrival)
  (node synth-lines.cjs items.json synth.json                      -> real Phonon voices, same code as the console)
  render-replay.py render  <scenario_dir> <synth.json> <out.mp4> [--footprint f.json] [--places p.json]

Real data: agent positions, speech and narration come from the recorded viewer stream + harness events. Not a screen capture:
the 3D world cannot be rendered fast enough in a GPU-less sandbox, so the map is the City 3 collision footprint, and playback
timing is scheduled with the console's own rules (range 16 m, per-speaker gap, one voice slot, stale lines dropped), not captured live.
"""
import sys, json, math, subprocess, bisect, wave, base64, os
import numpy as np
from PIL import Image, ImageDraw, ImageFont

BUBBLE_S = 5.0            # remoteFrames.BUBBLE_MS
EMITTER_FULL_M, EMITTER_AUDIBLE_M = 2.5, 16.0   # soundLogic
SPEAKER_GAP_S, NARRATION_GAP_S, STALE_S, NARRATION_STALE_S, MAX_QUEUE, LINE_GAP_S = 2.5, 3.0, 10.0, 8.0, 3, 0.3
SYNTH_LEAD_S = 0.35       # time from the event to the first sound, once the voice slot is free
FPS = 10
W, H, MAP = 1280, 720, 720

def load(scen):
    tap = [json.loads(l) for l in open(f"{scen}/tap.jsonl") if l.strip()]
    ev = [json.loads(l) for l in open(f"{scen}/events.jsonl") if l.strip()] if os.path.exists(f"{scen}/events.jsonl") else []
    meta = json.load(open(f"{scen}/meta.json"))
    return tap, ev, meta

def names_of(tap):
    names = {}
    for r in tap:
        if r["kind"] == "roster":
            for b in r["bodies"]:
                if b["name"]: names[b["n"]] = b["name"]
    return names

def poses_of(tap):
    tr = {}
    for r in tap:
        if r["kind"] == "pose":
            for p in r["p"]:
                tr.setdefault(p["n"], []).append((r["t"] / 1000.0, p["x"], p["z"], p["h"]))
    return tr

def pos_at(track, t):
    if not track: return None
    ts = [a[0] for a in track]
    i = bisect.bisect_left(ts, t)
    if i <= 0: return track[0][1:3]
    if i >= len(track): return track[-1][1:3]
    a, b = track[i - 1], track[i]; k = (t - a[0]) / ((b[0] - a[0]) or 1)
    return (a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k)

def gain(d):
    if d <= EMITTER_FULL_M: return 1.0
    if d >= EMITTER_AUDIBLE_M: return 0.0
    return 1.0 - (d - EMITTER_FULL_M) / (EMITTER_AUDIBLE_M - EMITTER_FULL_M)

def clean(s):
    import re
    s = re.sub(r"https?://\S+", "", s); s = re.sub(r"[*_`#>~]+", "", s)
    return re.sub(r"\s+", " ", s).strip()

def candidates(scen):
    """Lines the console would try to speak, with the rules that do not depend on audio length (range, per-speaker gap)."""
    tap, ev, meta = load(scen)
    names, tracks = names_of(tap), poses_of(tap)
    visitor = next((n for n, nm in names.items() if nm.startswith("Wren")), None)
    out, last = [], {}
    raw = []
    for r in tap:
        if r["kind"] == "say": raw.append((r["t"] / 1000.0, "say", r["n"], names.get(r["n"], "?"), r["text"]))
    for e in ev:
        # Logs written before the field rename carry the narration's own kind ("visible"/"thinking") in `kind`: the owner-received
        # events are the ones with an agentName.
        if e["kind"] == "owner_received" or (e["kind"] in ("visible", "thinking") and e.get("agentName")):
            raw.append((e["t"] / 1000.0, "inner", visitor, e.get("agentName", "agent"), e["text"]))
    raw.sort(key=lambda x: x[0])
    for t, kind, n, name, text in raw:
        text = clean(text)
        if not text: continue
        key = f"{kind}:{name}"
        gap = NARRATION_GAP_S if kind == "inner" else SPEAKER_GAP_S
        if key in last and t - last[key] < gap:
            out.append(dict(t=t, kind=kind, name=name, text=text, status="gap")); continue
        if kind == "say":
            me, sp = pos_at(tracks.get(visitor), t), pos_at(tracks.get(n), t)
            d = math.hypot(me[0] - sp[0], me[1] - sp[1]) if me and sp else 999
            if d > EMITTER_AUDIBLE_M:
                out.append(dict(t=t, kind=kind, name=name, text=text, status="far", dist=round(d, 1))); continue
            out.append(dict(t=t, kind=kind, name=name, text=text, status="ok", dist=round(d, 1))); last[key] = t
        else:
            out.append(dict(t=t, kind=kind, name=name, text=text, status="ok", dist=0.0)); last[key] = t
    return out, names, tracks, visitor, meta

def prepare(scen, items_path):
    cand, *_ = candidates(scen)
    items = [dict(key=f"{i}", name=c["name"], text=c["text"], inner=(c["kind"] == "inner")) for i, c in enumerate(cand) if c["status"] == "ok"]
    json.dump(items, open(items_path, "w"))
    json.dump(cand, open(items_path.replace(".json", ".cand.json"), "w"), indent=1)
    print(f"{len(items)} lines to synthesize ({sum(1 for c in cand if c['status']!='ok')} dropped by range/gap)")

def schedule(cand, synth):
    """Console rules with real audio lengths: one voice slot, FIFO, queue cap, stale lines dropped."""
    dur = {s["key"]: len(base64.b64decode(s["b64"])) / 2 / s["sampleRate"] for s in synth}
    played, free_at, pending = [], 0.0, []
    for i, c in enumerate(cand):
        if c["status"] != "ok": continue
        c = dict(c, key=str(i), seconds=dur.get(str(i), 0.0))
        pending.append(c)
    pending.sort(key=lambda c: c["t"])
    queue = []
    for c in pending:
        # drop what is still queued ahead of us if the queue is full (the console refuses the NEW line when the queue is full)
        queue = [q for q in queue if q["start"] + q["seconds"] > c["t"]]
        waiting = [q for q in queue if q["start"] > c["t"]]
        if len(waiting) >= MAX_QUEUE: c["status"] = "queue_full"; played.append(c); continue
        start = max(c["t"] + SYNTH_LEAD_S, free_at)
        stale = (NARRATION_STALE_S if c["kind"] == "inner" else STALE_S)
        if start - c["t"] > stale: c["status"] = "stale"; played.append(c); continue
        c["start"] = start; free_at = start + c["seconds"] + LINE_GAP_S; queue.append(c); played.append(c)
    return played

def render(scen, synth_path, out_mp4, footprint, places_path):
    cand, names, tracks, visitor, meta = candidates(scen)
    synth = json.load(open(synth_path)); sby = {s["key"]: s for s in synth}
    played = schedule(cand, synth)
    host = next((n for n, nm in names.items() if nm.startswith("Tobias")), None)
    T0, T1 = meta["goAt"] / 1000.0 - 4, meta["endAt"] / 1000.0
    dur = T1 - T0
    # --- audio mix
    SR = 24000; mix = np.zeros(int(dur * SR) + SR * 2, dtype=np.float32)
    for c in played:
        if "start" not in c or c["key"] not in sby: continue
        pcm = np.frombuffer(base64.b64decode(sby[c["key"]]["b64"]), dtype="<i2").astype(np.float32) / 32768.0
        g = 1.0 if c["kind"] == "inner" else gain(c["dist"])
        s0 = int((c["start"] - T0) * SR)
        if s0 < 0 or s0 >= len(mix): continue
        seg = pcm[: len(mix) - s0] * g
        mix[s0: s0 + len(seg)] += seg
    peak = float(np.max(np.abs(mix)) or 1.0); mix = mix / peak * 0.7
    wav = out_mp4.replace(".mp4", ".wav")
    with wave.open(wav, "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(SR); w.writeframes((mix * 32767).astype("<i2").tobytes())
    # --- map
    places = {p["id"]: p for p in json.load(open(places_path))}
    tea = places.get("shop-102", {}).get("pos", [-25, -72.5])
    pts = [(x, z) for n in (visitor, host) for (_, x, z, _) in tracks.get(n, [])]
    xs, zs = [p[0] for p in pts] + [tea[0]], [p[1] for p in pts] + [tea[1]]
    cx, cz = (min(xs) + max(xs)) / 2, (min(zs) + max(zs)) / 2
    size = max(max(xs) - min(xs), max(zs) - min(zs)) + 40
    sc = MAP / size
    def px(x, z): return ((x - cx) * sc + MAP / 2, (z - cz) * sc + MAP / 2)   # +z down (top-down, north = -z up)
    base = Image.new("RGB", (W, H), (14, 18, 25)); d = ImageDraw.Draw(base)
    d.rectangle([0, 0, MAP, H], fill=(18, 23, 32))
    fpd = json.load(open(footprint)); lo, hi = np.array([cx - size / 2 - 5, cz - size / 2 - 5]), np.array([cx + size / 2 + 5, cz + size / 2 + 5])
    tri = np.array(fpd["tris"], dtype=np.float32).reshape(-1, 3, 2)
    if len(tri):
        # long thin triangles are ground-plane fans, not objects: drawn, they show up as streaks across the map
        edge = np.maximum.reduce([np.hypot(*(tri[:, 0] - tri[:, 1]).T), np.hypot(*(tri[:, 1] - tri[:, 2]).T), np.hypot(*(tri[:, 2] - tri[:, 0]).T)])
        tri = tri[edge < 25]
        for t3 in tri[((tri.max(axis=1) >= lo) & (tri.min(axis=1) <= hi)).all(axis=1)]:
            d.polygon([px(float(a), float(b)) for a, b in t3], fill=(40, 50, 66))
    wl = np.array(fpd.get("walls", []), dtype=np.float32).reshape(-1, 2, 2)
    if len(wl):
        for s2 in wl[((wl.max(axis=1) >= lo) & (wl.min(axis=1) <= hi)).all(axis=1)]:
            d.line([px(float(s2[0][0]), float(s2[0][1])), px(float(s2[1][0]), float(s2[1][1]))], fill=(120, 136, 162), width=1)
    for p in places.values():
        x, z = p["pos"]
        if cx - size / 2 < x < cx + size / 2 and cz - size / 2 < z < cz + size / 2 and p["kind"] != "stall":
            X, Y = px(x, z); d.rectangle([X - 2, Y - 2, X + 2, Y + 2], fill=(96, 112, 138))
    d.rectangle([MAP, 0, W, H], fill=(14, 18, 25))   # the map layers can spill past the map: the panel is painted over them
    f = lambda s, b=False: ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans%s.ttf" % ("-Bold" if b else ""), s)
    X, Y = px(*tea); d.ellipse([X - 16, Y - 16, X + 16, Y + 16], outline=(255, 214, 102), width=2)
    d.text((X + 20, Y - 8), "Matchmaker's Tea House", font=f(14, True), fill=(255, 214, 102))
    cols = {visitor: (79, 209, 255), host: (255, 180, 84)}
    def wrap(txt, n=30):
        words, lines, cur = txt.split(), [], ""
        for w_ in words:
            if len(cur) + len(w_) + 1 > n: lines.append(cur); cur = w_
            else: cur = (cur + " " + w_).strip()
        return lines + [cur] if cur else lines
    says = [(c["t"], c) for c in cand if c["kind"] == "say"]
    ff = subprocess.Popen(["ffmpeg", "-y", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", f"{W}x{H}", "-r", str(FPS), "-i", "-", "-i", wav,
                           "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "24", "-c:a", "aac", "-b:a", "128k", "-shortest", out_mp4],
                          stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    nframes = int(dur * FPS)
    for fi in range(nframes):
        t = T0 + fi / FPS
        im = base.copy(); g = ImageDraw.Draw(im)
        for n in (visitor, host):
            tr = [a for a in tracks.get(n, []) if t - 70 <= a[0] <= t]
            if len(tr) > 1: g.line([px(a[1], a[2]) for a in tr], fill=tuple(int(v * 0.55) for v in cols[n]), width=2)
        me = pos_at(tracks.get(visitor), t)
        if me:
            X, Y = px(*me); r = EMITTER_AUDIBLE_M * sc
            for k in range(0, 360, 12): g.arc([X - r, Y - r, X + r, Y + r], k, k + 5, fill=(70, 130, 160))
        dots = {}
        for n in (visitor, host):
            p = pos_at(tracks.get(n), t)
            if not p or (tracks.get(n) and t < tracks[n][0][0] - 1): continue
            X, Y = px(*p); dots[n] = (X, Y); c = cols[n]
            g.ellipse([X - 7, Y - 7, X + 7, Y + 7], fill=c, outline=(255, 255, 255), width=2)
            g.text((X + 11, Y + 6), names.get(n, "?"), font=f(13, True), fill=c)
        # public speech bubbles (everyone sees these)
        for ts, c in says:
            if ts <= t <= ts + BUBBLE_S:
                n = next((k for k, nm in names.items() if nm == c["name"]), None)
                if n in dots:
                    X, Y = dots[n]; ls = wrap(c["text"]); bw = max(len(l) for l in ls) * 8 + 16; bh = len(ls) * 17 + 12
                    bx, by = X - bw / 2, Y - 28 - bh
                    bx = max(8, min(MAP - bw - 8, bx)); by = max(8, by)
                    g.rounded_rectangle([bx, by, bx + bw, by + bh], 8, fill=(244, 246, 250), outline=cols.get(n, (200, 200, 200)), width=2)
                    for i, l in enumerate(ls): g.text((bx + 8, by + 6 + i * 17), l, font=f(13), fill=(20, 24, 32))
        # owner-only inner voice, while it is spoken
        for c in played:
            if c["kind"] == "inner" and "start" in c and c["start"] <= t <= c["start"] + c["seconds"] + 1.2 and visitor in dots:
                X, Y = dots[visitor]; ls = wrap(c["text"], 34); bw = max(len(l) for l in ls) * 8 + 16; bh = len(ls) * 17 + 26
                bx, by = max(8, X - bw - 30), min(MAP - bh - 8, Y + 22)
                g.rounded_rectangle([bx, by, bx + bw, by + bh], 8, fill=(12, 36, 48), outline=(79, 209, 255), width=2)
                g.text((bx + 8, by + 4), "only the owner hears this", font=f(10), fill=(120, 190, 215))
                for i, l in enumerate(ls): g.text((bx + 8, by + 20 + i * 17), l, font=f(13), fill=(190, 235, 250))
        # panel
        x0 = MAP + 24
        g.text((x0, 22), "An agent in the Verse", font=f(24, True), fill=(235, 240, 248))
        g.text((x0, 56), f"owner's OAuth grant -> {meta.get('harness', '?')} harness -> /mcp/agent", font=f(12), fill=(150, 162, 182))
        g.text((x0, 94 - 2), f"model: {meta.get('model', '?')}", font=f(11), fill=(120, 130, 148))
        g.text((x0, 74), "replay of recorded data (not a screen capture)", font=f(12), fill=(150, 162, 182))
        el = int(max(0, t - T0 - 4)); g.text((x0, 112), f"t = {el // 60}:{el % 60:02d}", font=f(20, True), fill=(255, 214, 102))
        g.text((x0, 150), "What the owner hears", font=f(16, True), fill=(235, 240, 248))
        hist = [c for c in played if "start" in c and c["start"] <= t][-6:]
        y = 180
        for c in hist:
            now = c["start"] <= t <= c["start"] + c["seconds"]
            inner = c["kind"] == "inner"
            tag = "[inner voice] " if inner else f"[{c['name'].split('-')[0]} says] "
            colr = (79, 209, 255) if inner else (255, 255, 255)
            if not now: colr = tuple(int(v * 0.6) for v in colr)
            ls = wrap(tag + c["text"], 44)
            if now: g.rectangle([x0 - 8, y - 3, W - 14, y + len(ls) * 17 + 3], fill=(30, 40, 56))
            for l in ls[:4]: g.text((x0, y), l, font=f(13, now), fill=colr); y += 17
            y += 8
        far = [c for c in cand if c["status"] == "far" and c["t"] <= t][-2:]
        for c in far:
            g.text((x0, y), f"({c['name'].split('-')[0]} spoke {c['dist']} m away: out of earshot)", font=f(11), fill=(130, 140, 156)); y += 16
        ly = H - 128
        g.text((x0, ly), "Legend", font=f(12, True), fill=(150, 162, 182))
        g.ellipse([x0, ly + 24, x0 + 12, ly + 36], fill=cols[visitor]); g.text((x0 + 20, ly + 22), f"visitor ({meta.get('harness', '?')} agent)", font=f(12), fill=(200, 208, 222))
        g.ellipse([x0, ly + 44, x0 + 12, ly + 56], fill=cols[host]); g.text((x0 + 20, ly + 42), "host (scripted)", font=f(12), fill=(200, 208, 222))
        g.text((x0, ly + 62), "dashed ring = 16 m: the owner's hearing range", font=f(12), fill=(200, 208, 222))
        g.text((x0, ly + 84), "Map: City 3 collision footprint. Voices: Phonon, from the recorded text.", font=f(11), fill=(120, 130, 148))
        ff.stdin.write(im.tobytes())
    ff.stdin.close(); ff.wait()
    n_ok = sum(1 for c in played if "start" in c)
    print(f"rendered {nframes} frames, {n_ok} lines played, dropped:", {s: sum(1 for c in played if c['status'] == s) for s in ('queue_full', 'stale')},
          "far:", sum(1 for c in cand if c["status"] == "far"), "gap:", sum(1 for c in cand if c["status"] == "gap"))
    print("VIDEO:", out_mp4, os.path.getsize(out_mp4), "bytes")

if __name__ == "__main__":
    a = sys.argv[1:]
    if a[0] == "prepare": prepare(a[1], a[2])
    else:
        opts = {a[i]: a[i + 1] for i in range(4, len(a) - 1, 2)}
        render(a[1], a[2], a[3], opts.get("--footprint", "/tmp/footprint.json"),
               opts.get("--places", "/home/user/aiverse/apps/console/public/assets/city3-places.json"))
