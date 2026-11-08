#!/usr/bin/env python3
"""Slice-7 localhost end-to-end proof for the hunt service (SPEC §10.7).

Drives the REAL stack: hunt service (local) + console (local build, Scout
harness ?agent=1) — a hunter walks to the seeded spot in Kronikler Press,
position pings ride along (continuous claim checks, delta 1), the claim
resolves, and the public surface is audited.

Env:
  HUNT_API     hunt service base   (default http://localhost:8791)
  CONSOLE_URL  console url         (default http://localhost:5199/?world=city3&agent=1)
  ADMIN_TOKEN  hunt admin token    (required)
  WORK_DIR     artifacts dir       (required: log + screenshots + seed/codes)
Exits non-zero on the first failed assertion; every step is logged.
"""
import json
import math
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

import requests
from playwright.sync_api import sync_playwright

API = os.environ.get("HUNT_API", "http://localhost:8791")
CONSOLE_URL = os.environ.get("CONSOLE_URL", "http://localhost:5199/?world=city3&agent=1")
ADMIN = os.environ["ADMIN_TOKEN"]
WORK = Path(os.environ["WORK_DIR"])
WORK.mkdir(parents=True, exist_ok=True)
SPOT = (-33.99, 74.52)  # Kronikler Press approach point, calibrated in hunt v0
CODE = "LANTERN-OTTER-13"

LOG = open(WORK / "e2e-run.log", "a", buffering=1)


def log(step, msg=""):
    line = f"[{time.strftime('%H:%M:%S')}] {step} {msg}"
    print(line, flush=True)
    LOG.write(line + "\n")


def check(cond, step, msg=""):
    if not cond:
        log("FAIL", f"{step} {msg}")
        sys.exit(1)
    log("ok", f"{step} {msg}")


def admin(method, path, body=None):
    r = requests.request(
        method, f"{API}{path}", json=body, headers={"Authorization": f"Bearer {ADMIN}"}, timeout=15
    )
    r.raise_for_status()
    return r.json()


def magic_session(email):
    requests.post(f"{API}/v1/auth/magic-link", json={"email": email}, timeout=15)
    link = None
    for line in (WORK / "dev-outbox.jsonl").read_text().splitlines():
        row = json.loads(line)
        if row["email"] == email:
            link = row["link"]
    assert link, f"no outbox link for {email}"
    r = requests.get(link, allow_redirects=False, timeout=15)
    assert r.status_code == 302, r.status_code
    return r.headers["Location"].split("#hunt_session=")[1]


# ---------- 1. seed the event through the admin CLI ----------
now_ms = int(time.time() * 1000)
seed = json.loads(Path(__file__).with_name("seed-e2e.json").read_text())
seed["event"]["starts_at"] = now_ms - 60_000
seed["event"]["ends_at"] = now_ms + 90 * 60_000  # headless walks are slow; the window must outlast them
seed["hints"][0]["fires_at"] = now_ms - 60_000
seed_path = WORK / "seed-runtime.json"
seed_path.write_text(json.dumps(seed))
codes_path = WORK / "codes.local.json"
codes_path.write_text(json.dumps({"a $25 gift code (E2E proof)": CODE}))
env = {**os.environ, "HUNT_API_URL": API, "HUNT_ADMIN_TOKEN": ADMIN}
out = subprocess.run(
    ["bun", "run", "admin", "--", "seed-event", str(seed_path), str(codes_path)],
    cwd=Path(__file__).parents[2],  # apps/hunt
    env=env, capture_output=True, text=True, timeout=60,
)
log("seed-cli", out.stdout.strip().replace("\n", " | "))
check(out.returncode == 0, "seed via CLI", out.stderr[-300:])
event_id = [l for l in out.stdout.splitlines() if l.startswith("event_id:")][0].split(":", 1)[1].strip()
sched = admin("POST", f"/v1/admin/events/{event_id}/schedule")
log("schedule", json.dumps(sched))
state = requests.get(f"{API}/v1/events/e2e-bazaar-drop/state", timeout=15).json()
check(state["state"] == "live" and state["prizes_total"] == 1, "event live, counter 0/1", json.dumps(state))

# ---------- 2. hunter identity via the stubbed magic link ----------
session = magic_session("e2e-hunter@example.com")
H = {"Authorization": f"Bearer {session}"}
me = requests.get(f"{API}/v1/me", headers=H, timeout=15).json()
log("identity", f"hunter user {me['id'][:8]} display={me['display_name']}")

# ---------- 3. public SSE feed recorder ----------
feed_events = []


def record_feed():
    try:
        with requests.get(f"{API}/v1/events/e2e-bazaar-drop/feed", stream=True, timeout=600) as r:
            ev = None
            for line in r.iter_lines(decode_unicode=True):
                if line is None:
                    continue
                if line.startswith("event:"):
                    ev = line[6:].strip()
                elif line.startswith("data:") and ev:
                    feed_events.append((time.time(), ev, line[5:].strip()))
                    if ev == "hunt_end":
                        return
    except Exception as e:  # noqa: BLE001
        log("feed-thread", f"ended: {e}")


threading.Thread(target=record_feed, daemon=True).start()
time.sleep(1)

# ---------- 4. walk the Scout to the spot, pinging positions ----------
won = {"via": None, "code": None}


def ping(pos):
    r = requests.post(
        f"{API}/v1/positions",
        json={"event_id": event_id, "body_id": "remy",
              "position": {"x": pos[0], "y": pos[1], "z": pos[2]}, "client_ts": int(time.time() * 1000)},
        headers=H, timeout=15,
    )
    if r.status_code == 200 and r.json().get("result") == "won":
        won["via"] = "ping"
        won["code"] = r.json()["code"]
        log("ping-win", "claim resolved by a position ping (continuous checks)")
    return r


def dist_to_spot(pos):
    return math.hypot(pos[0] - SPOT[0], pos[2] - SPOT[1])


with sync_playwright() as pw:
    browser = pw.chromium.launch(args=["--use-gl=swiftshader"])
    page = browser.new_page(viewport={"width": 1280, "height": 800})
    page.goto(CONSOLE_URL)
    page.wait_for_function("window.__scout && window.__scout.ready()", timeout=300_000)
    snap = page.evaluate("window.__scout.snapshot()")
    log("scout-ready", f"spawn pos={snap['pos']}")
    page.screenshot(path=str(WORK / "e2e-spawn.png"))
    places = page.evaluate("window.__scout.places()")
    log("places", f"{len(places)} go-to-able places")

    def run_leg(action, label):
        """Issue one go_to and ping every ~3 s until it settles or we win."""
        page.evaluate(
            """(a) => {
              window.__e2e_act_result = undefined;
              window.__scout.act(a).then((r) => { window.__e2e_act_result = r; });
              return true;
            }""",
            action,
        )
        deadline = time.time() + 600
        pos = None
        while time.time() < deadline:
            s = page.evaluate("window.__scout.snapshot()")
            pos = s["pos"]
            ping(pos)
            if won["via"]:
                break
            if page.evaluate("window.__e2e_act_result !== undefined"):
                break
            time.sleep(3)
        result = page.evaluate("window.__e2e_act_result ?? null")
        log("leg", f"{label}: {json.dumps(result)[:160]} pos={pos} dist={dist_to_spot(pos):.2f}")
        return result, pos

    # Greedy place-hopping (the hunt v0 pattern): hop to the unvisited place
    # that most reduces distance-to-spot; tolerate blocked legs by moving on.
    # Inside ~18 m, go straight for the spot; via the shop-front anchor
    # (-25, 72.5) first if a direct interior leg blocks (v0's proven entry).
    # A leg that settles with <0.5 m of movement means the body is wedged on
    # collision (measured twice at x=-14.6): recover by retreating east and
    # shifting z +-13 m, then re-approach from the new bearing.
    last_pos = page.evaluate("window.__scout.snapshot()")["pos"]
    visited = set()
    anchor_tried = False
    recoveries = 0

    def do_leg(action, label):
        global last_pos, recoveries
        before = last_pos
        result, pos = run_leg(action, label)
        last_pos = pos
        if won["via"] or result is None or result.get("status") != "blocked":
            return result
        moved = math.hypot(pos[0] - before[0], pos[2] - before[2])
        if moved >= 0.5:
            return result
        recoveries += 1
        rz = pos[2] + (13 if recoveries % 2 == 1 else -13)
        rx = pos[0] + 7
        log("recovery", f"wedged at {pos}; retreating to ({rx:.1f}, {rz:.1f})")
        _, pos2 = run_leg({"type": "go_to", "point": [rx, rz]}, f"recovery #{recoveries}")
        last_pos = pos2
        return result

    for leg_no in range(24):
        if won["via"] or dist_to_spot(last_pos) <= 1.5:
            break
        d = dist_to_spot(last_pos)
        if d <= 18:
            action = {"type": "go_to", "point": [SPOT[0], SPOT[1]]}
            result = do_leg(action, f"#{leg_no} direct-to-spot")
            if won["via"] or dist_to_spot(last_pos) <= 1.5:
                break
            if not anchor_tried:
                anchor_tried = True
                result = do_leg({"type": "go_to", "place": "shop-98"}, f"#{leg_no} via Press anchor")
                continue
            break
        cands = []
        for p in places:
            if p["id"] in visited:
                continue
            stand = p.get("stand") or p["pos"]
            hop = math.hypot(stand[0] - last_pos[0], stand[1] - last_pos[2])
            gain = d - math.hypot(stand[0] - SPOT[0], stand[1] - SPOT[1])
            if hop <= 55 and gain > 2:
                cands.append((gain, p["id"]))
        if not cands:
            log("legs", "no progressing place left; trying the spot directly")
            result = do_leg({"type": "go_to", "point": [SPOT[0], SPOT[1]]}, f"#{leg_no} long-direct")
            break
        cands.sort(reverse=True)
        target = cands[0][1]
        visited.add(target)
        result = do_leg({"type": "go_to", "place": target}, f"#{leg_no} place {target}")

    dist = dist_to_spot(last_pos)
    log("arrival", f"pos={last_pos} distance-to-spot={dist:.3f} m")
    page.screenshot(path=str(WORK / "e2e-spot.png"))
    check(dist <= 1.5, "hunter standing inside the 1.5 m claim radius", f"dist={dist:.3f}")
    browser.close()

# ---------- 5. the claim itself (if a ping didn't already win it) ----------
if not won["via"]:
    r = requests.post(
        f"{API}/v1/claims",
        json={"event_id": event_id, "body_id": "remy",
              "position": {"x": last_pos[0], "y": last_pos[1], "z": last_pos[2]},
              "client_ts": int(time.time() * 1000)},
        headers=H, timeout=15,
    )
    body = r.json()
    log("claim", json.dumps(body))
    check(body.get("result") == "won", "formal claim wins", json.dumps(body))
    won["via"] = "claim"
    won["code"] = body["code"]
check(won["code"] == CODE, "code revealed to the winner", f"via={won['via']}")

# ---------- 6. winner-only + counter + a latecomer's honest verdict ----------
wins = requests.get(f"{API}/v1/me/wins", headers=H, timeout=15).json()["wins"]
check(len(wins) == 1 and wins[0]["code"] == CODE, "winner re-reads own code")
other = magic_session("e2e-latecomer@example.com")
r = requests.post(
    f"{API}/v1/claims",
    json={"event_id": event_id, "body_id": "remy",
          "position": {"x": SPOT[0], "y": 0.48, "z": SPOT[1]}, "client_ts": int(time.time() * 1000)},
    headers={"Authorization": f"Bearer {other}"}, timeout=15,
)
check(r.json().get("result") == "already_claimed" and "code" not in r.json(),
      "latecomer at the spot: already_claimed, no code", r.text[:200])
state = requests.get(f"{API}/v1/events/e2e-bazaar-drop/state", timeout=15).json()
check(state["prizes_claimed"] == 1 and state["prizes_remaining"] == 0, "public counter moved", json.dumps(state))

# ---------- 7. close the event; audit the feed ----------
admin("POST", f"/v1/admin/events/{event_id}/end")
time.sleep(3)
kinds = [e for _, e, _ in feed_events]
log("feed", f"events seen: {kinds}")
check("hunt_start" in kinds, "feed carried hunt_start")
check("prize_claimed" in kinds, "feed carried prize_claimed")
check("hunt_end" in kinds, "feed carried hunt_end")
hint_tiers = [json.loads(d).get("tier") for _, e, d in feed_events if e == "hint"]
log("feed", f"hint tiers fired: {hint_tiers}")
check("room" in hint_tiers, "progress-paced room hint fired on approach (hunters_in_area)")
claimed_payload = [d for _, e, d in feed_events if e == "prize_claimed"][0]
check(CODE not in claimed_payload and '"x"' not in claimed_payload,
      "prize_claimed payload carries no code, no coordinates")
log("E2E", "ALL CHECKS PASSED")
