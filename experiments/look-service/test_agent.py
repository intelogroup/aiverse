#!/usr/bin/env python3
"""TEST AGENT — data-only navigation + decided snapshots (look service v1).

Mission: find and photograph Mira, the resident figure standing at
(-26.6, -70.4) on the street left of the Tea House (published place
shop-102 "Matchmaker's Tea House", stand (-25.0, -72.5)).

Rules the agent lives by (the commission):
- Navigation uses DATA ONLY: the published places file + its own
  proprioception (service pose echo). No frames are used to navigate.
- A look is fired ONLY on a decision event: arrival at a planned
  vantage, or a scan step after a negative verdict. Never on a timer.
- A snapshot is kept ONLY when the perception check confirms the
  target is in view: depth candidate gate (solid aim-point return)
  AND Agnes 2.5 Flash VLM verdict "target_visible": true.
- Every decision is logged with a UTC timestamp to
  agent-decisions.jsonl — the log is the proof of discipline.
"""
import base64, json, math, sys, time, urllib.request, urllib.error
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, "/opt/muse/skills/custom-connector-setup/bin")
import dynamic_credentials as dc  # noqa: E402

HERE = Path(__file__).parent
SVC = "http://127.0.0.1:5317"
AGENT = "test-agent-1"
LOG = HERE / "agent-decisions.jsonl"
PLACES = json.loads(Path(
    "/home/hatch/workspace/.build-tmp/ws-main/apps/console/public/assets/city3-places.json"
).read_text())

MIRA = (-26.6, -70.4)            # resident figure, Tea House street-side
TEA = next(p for p in PLACES if p["id"] == "shop-102")
# Vantage history: the Tea House interior stand (-25.0,-72.5) is NOT
# routable by the executor's planner ("blocked: no safe route" from two
# different starts, probe_move.py 2026-11-10) — the planner's groundY
# gate rejects the raised interior doorstep. Mira stands OUTSIDE on the
# street, so the mission uses street vantages ~6 m from her instead.
VANTAGES = [(-26.6, -64.2), (-21.0, -68.0), (-31.5, -66.5)]


def utc():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def log(kind, **kw):
    rec = {"utc": utc(), "kind": kind, **kw}
    with LOG.open("a") as f:
        f.write(json.dumps(rec) + "\n")
    print(json.dumps(rec), flush=True)


def post(path, body, timeout=720):
    req = urllib.request.Request(SVC + path, data=json.dumps(body).encode(),
                                 method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def bearing(frm, to):
    """Heading (deg) that faces `to` from `frm`, in the rig's convention:
    forward = (sin h, cos h) over (x, z)."""
    return round(math.degrees(math.atan2(to[0] - frm[0], to[1] - frm[1])), 1)


def agnes_verdict(png_b64):
    """VLM confirm: is Mira (maid-outfit woman) visible in this frame?"""
    payload = {
        "model": "agnes-2.5-flash",
        "max_tokens": 400,
        "messages": [
            {"role": "system", "content":
             "You are a perception checker for an agent in a 3D town. "
             "Answer with strict JSON only."},
            {"role": "user", "content": [
                {"type": "text", "text":
                 "Is a woman wearing a black-and-white maid outfit "
                 "(dress with white apron) visible standing in this "
                 "frame? Reply JSON: {\"target_visible\": true/false, "
                 "\"where\": \"short description of where she is in the "
                 "frame, or empty\", \"scene\": \"one-line scene "
                 "description\"}"},
                {"type": "image_url", "image_url": {
                    "url": "data:image/png;base64," + png_b64}},
            ]},
        ],
    }
    req = urllib.request.Request(
        "https://apihub.agnes-ai.com/v1/chat/completions",
        data=json.dumps(payload).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    dc.add_surrogate_to_request(req, "custom.agnes-ai",
                                allowed_hosts=["apihub.agnes-ai.com"])
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=120) as r:
        body = dc.read_json_response(r)
    api_ms = round((time.time() - t0) * 1000)
    content = ((body.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
    text = content.strip()
    if "```" in text:
        text = text.split("```")[1].lstrip("json").strip()
    try:
        verdict = json.loads(text)
    except Exception:
        verdict = {"target_visible": False, "parse_error": content[:200]}
    return verdict, api_ms


def main():
    looks = 0
    log("mission-start", target="Mira @ Tea House patio",
        targetPos=list(MIRA), dataSource="city3-places.json (published)")
    pose = post("/move", {"agentId": AGENT})["pose"]
    log("proprioception", pos=pose["pos"], bodyHeadingDeg=pose["bodyHeadingDeg"],
        note="spawn pose from service snapshot; navigation is data-only from here")

    kept = None
    for vi, vantage in enumerate(VANTAGES):
        b = bearing(vantage, MIRA)
        log("nav-decision", vantage=list(vantage), faceBearingDeg=b,
            why="published stand/vantage point; face the target's known position")
        mv = None
        for attempt in range(3):
            mv = post("/move", {"agentId": AGENT, "position": list(vantage),
                                "headingDeg": b, "mode": "run"})
            log("move", attempt=attempt, outcomes=mv.get("outcomes"),
                pose=mv["pose"]["pos"],
                bodyHeadingDeg=mv["pose"]["bodyHeadingDeg"], poseMs=mv["poseMs"])
            p = mv["pose"]["pos"]
            if math.hypot(p[0] - vantage[0], p[2] - vantage[1]) < 2.0:
                break
            log("nav-decision", why="not yet at vantage; re-issue move")
        p = mv["pose"]["pos"]
        if math.hypot(p[0] - vantage[0], p[2] - vantage[1]) >= 2.0:
            log("vantage-unreachable", vantage=list(vantage),
                outcomes=mv.get("outcomes"),
                why="move never arrived; NO looks fired from the wrong place")
            continue

        # scan: centre bearing, then -25 / +25 offsets if not confirmed
        for si, off in enumerate([0, -25, 25]):
            if si > 0:
                h = round(b + off, 1)
                log("nav-decision", scanStep=si, faceBearingDeg=h,
                    why="previous verdict negative; scan offset")
                post("/move", {"agentId": AGENT, "headingDeg": h})
            lk = post("/look", {"agentId": AGENT})
            looks += 1
            frame_path = HERE / f"agent-look-{looks:02d}.png"
            frame_path.write_bytes(base64.b64decode(lk["png_b64"]))
            ds = lk.get("depthSummary") or {}
            centre = ds.get("centreMedian")
            candidate = centre is not None and 0.4 <= centre <= 20.0
            log("look-fired", seq=looks, why="arrival/scan decision point",
                pose=lk["pose"]["pos"], bodyHeadingDeg=lk["pose"]["bodyHeadingDeg"],
                renderMs=lk["renderMs"], depthCentreMedian=centre,
                cvCandidate=candidate, frame=str(frame_path))
            if not candidate:
                log("snapshot-declined", seq=looks,
                    why=f"depth candidate gate failed (centreMedian={centre})")
                continue
            verdict, api_ms = agnes_verdict(lk["png_b64"])
            log("vlm-verdict", seq=looks, verdict=verdict, apiMs=api_ms)
            if verdict.get("target_visible"):
                snap = post("/snapshot", {
                    "agentId": AGENT,
                    "note": f"Mira confirmed in view from {lk['pose']['pos']} "
                            f"heading {lk['pose']['bodyHeadingDeg']}: "
                            f"{verdict.get('where', '')}"})
                kept = snap["snapshot"]
                log("snapshot-kept", record=kept)
                break
            log("snapshot-declined", seq=looks,
                why="VLM did not confirm the target in frame")
        if kept:
            break

    log("mission-end", looksFired=looks, snapshotsKept=1 if kept else 0,
        kept=kept)
    print("MISSION DONE", json.dumps({"looks": looks, "kept": bool(kept)}))


if __name__ == "__main__":
    main()
