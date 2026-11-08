#!/usr/bin/env python3
"""Listen-and-review harness for the AIVerse console sound stack.

The procedure is stolen, legally, from earshot (MIT,
github.com/Leonxlnx/earshot) — see README.md for the mapping. In
short: earshot renders a mix, measures a scorecard of metrics
against declared ranges, and returns a numeric verdict ("21 of 23
in range") an agent can iterate against. This harness does the
same for a LIVE world: scenes are declared in spec.json, each
scene performs itself in a headless production build of the
console through the ?soundDebug=1 / ?walkDebug=1 hooks, samples
the sound director's bus analysers, and scores every measurement
against its declared range. Output: a verdict table on stdout, a
machine-readable JSON report, and exit code 1 if any scored check
is out of range (2 on harness error).

Usage:
    python3 listen_review.py [--build] [--url URL] [--port N]
                             [--spec spec.json] [--out report.json]
                             [--only check-id,...] [--keep-server]

Without --url the harness boots `vite preview` itself from the
console directory (a production build must exist: pass --build to
run `bun run build` first). Requirements: python3 + playwright
(with its chromium), bun. Headless Chromium here renders with
SwiftShader, so scene timings poll-until-converged instead of
sleeping fixed durations — the same discipline as the sound
proofs this harness generalizes.
"""
import argparse
import json
import os
import subprocess
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
CONSOLE_DIR = os.path.abspath(os.path.join(HERE, "..", ".."))
WEIGHTS = {"critical": 3, "major": 2, "minor": 1}
CHROME_ARGS = [
    "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
    "--no-sandbox", "--disable-dev-shm-usage",
]
AUTOPLAY_ARG = "--autoplay-policy=no-user-gesture-required"


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def dig(snap, field):
    """Dotted-path read into a snapshot dict ('gains.wind')."""
    cur = snap
    for part in field.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return None
        cur = cur[part]
    return cur


def field_present(snap, field):
    cur = snap
    for part in field.split("."):
        if not isinstance(cur, dict) or part not in cur:
            return False
        cur = cur[part]
    return True


class Session:
    """One browser profile's page + snapshot plumbing."""

    def __init__(self, pw, base_url, profile):
        args = list(CHROME_ARGS)
        if profile != "no-autoplay":
            args.append(AUTOPLAY_ARG)
        self.browser = pw.chromium.launch(args=args)
        self.page = self.browser.new_page(viewport={"width": 800, "height": 500})
        self.errors = []
        self.page.on("pageerror", lambda e: self.errors.append(str(e)[:200]))
        self.broken = None
        self.page.goto(base_url)
        self.page.wait_for_function("window.__walk && window.__sound",
                                    timeout=300000)

    def snap(self):
        try:
            return self.page.evaluate(
                "window.__sound ? window.__sound.snapshot() : null")
        except Exception:
            return None

    def evaluate(self, js):
        return self.page.evaluate(js)

    def close(self):
        try:
            self.browser.close()
        except Exception:
            pass


def predicate(snap, pred):
    """pred: {field, equals|in|gt|gte|lt|lte|absDiffTo+tol, truthy}."""
    if snap is None:
        return False
    v = dig(snap, pred["field"])
    if "equals" in pred:
        return v == pred["equals"]
    if "in" in pred:
        return v in pred["in"]
    if "truthy" in pred:
        return bool(v) is pred["truthy"]
    if v is None:
        return False
    if "absDiffTo" in pred:
        return abs(v - pred["absDiffTo"]) <= pred.get("tol", 0.01)
    if "gt" in pred:
        return v > pred["gt"]
    if "gte" in pred:
        return v >= pred["gte"]
    if "lt" in pred:
        return v < pred["lt"]
    if "lte" in pred:
        return v <= pred["lte"]
    return False


class CheckRun:
    """Executes one check's steps, collecting snapshots into buckets."""

    def __init__(self, session, check):
        self.s = session
        self.check = check
        self.buckets = {}
        self.step_error = None

    def record(self, bucket, snap):
        if snap is not None:
            self.buckets.setdefault(bucket, []).append(snap)

    def sample_for(self, bucket, seconds, interval=0.15):
        t0 = time.time()
        while time.time() - t0 < seconds:
            self.record(bucket, self.s.snap())
            time.sleep(interval)

    def poll(self, bucket, pred, timeout_s, interval=0.4):
        """Poll until the predicate holds; only the converged snapshot
        is recorded, so approach ramps never pollute a bucket's mean."""
        t0 = time.time()
        last = None
        while time.time() - t0 < timeout_s:
            last = self.s.snap()
            if predicate(last, pred):
                self.record(bucket, last)
                return True
            time.sleep(interval)
        self.record(bucket, last)
        return False

    def run_steps(self):
        for step in self.check.get("steps", []):
            if self.step_error:
                break
            self.run_step(step)

    def run_step(self, step):
        op = step["op"]
        bucket = step.get("bucket", "main")
        if op == "put":
            self.s.evaluate(
                f"window.__walk.put({step['x']}, {step.get('y', 0.2)}, "
                f"{step['z']}, {step.get('heading', 0)})")
            time.sleep(step.get("settleS", 0.5))
            # No snapshot recorded here on purpose: the walker moves
            # instantly but the director's listener feed lags seconds
            # behind a teleport, so a post-put snapshot measures the
            # OLD position. The following poll records the converged
            # state — that is the first honest reading at the new
            # position. (Run3 evidence: a recorded post-put snapshot
            # — district still bazaar, wind 0.055 — polluted the
            # glassq bucket and read as a false HIGH.)
        elif op == "arm":
            self.s.evaluate("window.__sound.arm()")
        elif op == "waitWalk":
            # Session gate for profiles that must NOT arm: the
            # director's district read needs its district defs, which
            # load inside arm() — so pre-consent, settle evidence is
            # the walker's own state (spawned, finite position).
            timeout = step.get("timeoutS", 480)
            t0 = time.time()
            ok = False
            while time.time() - t0 < timeout:
                st = self.s.evaluate(
                    "window.__walk ? window.__walk.state() : null")
                if (isinstance(st, dict)
                        and isinstance(st.get("x"), (int, float))
                        and isinstance(st.get("z"), (int, float))):
                    ok = True
                    break
                time.sleep(1.0)
            if not ok:
                self.step_error = f"waitWalk timed out after {timeout}s"
        elif op == "announce":
            self.announce(step, bucket)
        elif op == "poll":
            ok = self.poll(bucket, step["until"], step.get("timeoutS", 60))
            if not ok and not step.get("optional"):
                self.step_error = (
                    f"poll timed out after {step.get('timeoutS', 60)}s "
                    f"waiting for {step['until']}")
        elif op == "sample":
            self.sample_for(bucket, step.get("seconds", 5),
                            step.get("intervalS", 0.15))
        elif op == "sleep":
            time.sleep(step.get("seconds", 1))
        elif op == "clickWalkButton":
            clicked = self.s.evaluate(
                """(label) => {
                  const btn = [...document.querySelectorAll(
                    '.w-walk-panel button')]
                    .find(b => b.textContent.trim() === label);
                  if (!btn) return false;
                  btn.click();
                  return true;
                }""", step["label"])
            if not clicked and not step.get("optional"):
                self.step_error = f"walk button not found: {step['label']}"
        elif op == "realClick":
            self.s.page.mouse.click(step.get("x", 400), step.get("y", 250))
            time.sleep(step.get("settleS", 0.5))
            self.record(bucket, self.s.snap())
        elif op == "consent":
            # The permission gesture. On consent-gated trees (PR #37+)
            # the walk HUD shows an explicit "Enable sound" control
            # (.w-sound-enable): click THAT, with trusted input — the
            # grant must happen inside a real gesture's call stack.
            # On pre-gate trees no such control exists and any first
            # gesture arms the director, so fall back to a raw canvas
            # click. The record shows which path fired.
            clicked = None
            try:
                btn = self.s.page.locator(".w-sound-enable")
                btn.first.wait_for(state="visible",
                                   timeout=step.get("waitS", 45000))
                btn.first.click(timeout=10000)
                clicked = "Enable sound button"
            except Exception:
                clicked = None
            if not clicked:
                # The button did not paint in time (headless React
                # can lag far behind the hooks under SwiftShader).
                # Consent-gated trees expose the very grantConsent()
                # the button calls on the ?soundDebug hook — use it,
                # and keep the path named in the log so a genuinely
                # missing button is never masked silently.
                try:
                    if self.s.evaluate(
                            "!!(window.__sound && "
                            "window.__sound.grantConsent)"):
                        self.s.evaluate("window.__sound.grantConsent()")
                        clicked = "soundDebug grant hook (button not painted)"
                except Exception:
                    clicked = None
            if not clicked:
                self.s.page.mouse.click(step.get("x", 400),
                                        step.get("y", 250))
                clicked = "raw gesture fallback"
            log(f"    consent via {clicked}")
            time.sleep(step.get("settleS", 0.5))
            self.record(bucket, self.s.snap())
        elif op == "realKey":
            self.s.page.keyboard.press(step.get("key", "Space"))
            time.sleep(step.get("settleS", 0.5))
            self.record(bucket, self.s.snap())
        elif op == "snapshot":
            self.record(bucket, self.s.snap())
        else:
            self.step_error = f"unknown step op: {op}"

    def announce(self, step, bucket):
        js = (f"window.__sound.announce({json.dumps(step['text'])}, "
              f"{json.dumps(step['scope'])}, "
              f"{json.dumps(step.get('clip'))})")
        attempts = step.get("attempts", 1)
        sample_s = step.get("sampleS", 7)
        for i in range(attempts):
            self.record(bucket, self.s.snap())  # pre-state (delta measures)
            self.s.evaluate(js)
            self.sample_for(bucket, sample_s)
            if "untilField" not in step:
                return
            peak = bucket_peak(self.buckets.get(bucket, []),
                               step["untilField"])
            if peak is not None and peak > step.get("untilAbove", 0.005):
                return
            if i < attempts - 1:
                log(f"    announce attempt {i + 1}: peak "
                    f"{peak if peak is None else round(peak, 4)}; retrying")
                time.sleep(3)


def bucket_peak(snaps, field):
    vals = [dig(s, field) for s in snaps]
    vals = [v for v in vals if isinstance(v, (int, float))]
    return max(vals) if vals else None


def eval_measure(buckets, m):
    """One measurement -> {name, value, status, detail}."""
    snaps = buckets.get(m.get("bucket", "main"), [])
    field, agg = m["field"], m.get("agg", "peak")
    out = {"name": m["name"], "field": field, "agg": agg}
    if agg == "present":
        val = any(bool(dig(s, field)) for s in snaps)
        out.update(value=val, status="ok" if val else "miss",
                   detail=f"expected {field} to be present/truthy")
        return out
    if agg == "absent":
        val = any(bool(dig(s, field)) for s in snaps)
        out.update(value=val, status="ok" if not val else "miss",
                   detail=f"expected {field} to stay absent/falsy")
        return out
    if agg in ("equals", "in"):
        last = dig(snaps[-1], field) if snaps else None
        ok = (last == m["equals"]) if agg == "equals" else (last in m["in"])
        out.update(value=last, status="ok" if ok else "miss",
                   detail=f"expected {field} == {m.get('equals', m.get('in'))}")
        return out
    vals = [dig(s, field) for s in snaps]
    nums = [v for v in vals if isinstance(v, (int, float))]
    if agg == "delta":
        raw = [v for v in vals if isinstance(v, (int, float))]
        value = (raw[-1] - raw[0]) if len(raw) >= 2 else None
    elif agg == "peak":
        value = max(nums) if nums else None
    elif agg == "min":
        value = min(nums) if nums else None
    elif agg == "mean":
        value = sum(nums) / len(nums) if nums else None
    elif agg == "last":
        value = nums[-1] if nums else None
    else:
        value = None
    out["value"] = None if value is None else round(value, 4)
    if value is None:
        out.update(status="miss", detail=f"no numeric samples of {field}")
        return out
    if "min" in m and value < m["min"]:
        out.update(status="low",
                   detail=f"{value:.4f} < min {m['min']}")
    elif "max" in m and value > m["max"]:
        out.update(status="high",
                   detail=f"{value:.4f} > max {m['max']}")
    else:
        rng = []
        if "min" in m:
            rng.append(f">= {m['min']}")
        if "max" in m:
            rng.append(f"<= {m['max']}")
        out.update(status="ok", detail=f"in range ({', '.join(rng)})")
    return out


def score_checks(rows):
    """Earshot's verdict maths (critique.py scorecard): weights
    critical 3 / major 2 / minor 1; weighted share of in-range
    scored checks; launch-grade >= 90% with no critical issue,
    close >= 75% with no critical issue, needs work >= 50%."""
    scored = [r for r in rows if r["status"] not in ("skipped",)]
    wsum = sum(WEIGHTS[r["weight"]] for r in scored)
    ok_w = sum(WEIGHTS[r["weight"]] for r in scored if r["status"] == "ok")
    score = (ok_w / wsum) if wsum else None
    n_crit = sum(1 for r in scored
                 if r["weight"] == "critical" and r["status"] != "ok")
    n_major = sum(1 for r in scored
                  if r["weight"] == "major" and r["status"] != "ok")
    verdict = ("n.a." if score is None else
               "launch-grade" if score >= 0.9 and not n_crit else
               "close" if score >= 0.75 and not n_crit else
               "needs work" if score >= 0.5 else "not launch-grade")
    return {
        "verdict": verdict,
        "score": None if score is None else round(score, 3),
        "in_range": sum(1 for r in scored if r["status"] == "ok"),
        "scored": len(scored),
        "skipped": sum(1 for r in rows if r["status"] == "skipped"),
        "critical_issues": n_crit,
        "major_issues": n_major,
    }


def verdict_line(summary):
    return (f"{summary['verdict']} - {summary['in_range']} of "
            f"{summary['scored']} scored checks in range (weighted "
            f"{100 * (summary['score'] or 0):.0f}%), "
            f"{summary['critical_issues']} critical and "
            f"{summary['major_issues']} major issues.")


def print_report(report):
    s = report["summary"]
    print()
    print(f"LISTEN-REVIEW: {report['target']}")
    print(f"VERDICT: {verdict_line(s)}")
    fails = [r for r in report["checks"] if r["status"] not in ("ok", "skipped")]
    if fails:
        print("FIX FIRST (most important first):")
        for r in sorted(fails, key=lambda r: -WEIGHTS[r["weight"]]):
            bad = [m for m in r["measures"] if m["status"] != "ok"]
            desc = "; ".join(
                f"{m['name']}: {m['detail']}" for m in bad) or r.get("error", "")
            print(f"  [{r['weight']}] {r['id']} - {desc}")
            if r.get("fix"):
                print(f"      fix: {r['fix']}")
    print()
    print(f"{'CHECK':28s} {'weight':9s} {'value(s)':38s} status")
    for r in report["checks"]:
        vals = ", ".join(
            f"{m['name']}={m['value']}" for m in r["measures"])[:38]
        print(f"{r['id']:28s} {r['weight']:9s} {vals:38s} {r['status']}")
        if r["status"] == "skipped":
            print(f"  skipped: {r.get('skipReason', '')}")
        if r.get("error"):
            print(f"  error: {r['error']}")
    print()
    print(f"VERDICT: {verdict_line(s)}")


def wait_http(url, timeout_s=120):
    t0 = time.time()
    while time.time() - t0 < timeout_s:
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(2)
    return False


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--spec", default=os.path.join(HERE, "spec.json"))
    ap.add_argument("--url", default=None,
                    help="attach to a running server instead of booting one")
    ap.add_argument("--port", type=int, default=5199)
    ap.add_argument("--build", action="store_true",
                    help="run `bun run build` in the console first")
    ap.add_argument("--out", default=None,
                    help="JSON report path (default: alongside the spec)")
    ap.add_argument("--only", default=None,
                    help="comma-separated check ids to run")
    ap.add_argument("--keep-server", action="store_true")
    args = ap.parse_args()

    with open(args.spec) as f:
        spec = json.load(f)
    only = set(args.only.split(",")) if args.only else None

    if args.build:
        log("building console (bun run build)...")
        subprocess.run(["bun", "run", "build"], cwd=CONSOLE_DIR, check=True)

    server = None
    base = args.url
    if not base:
        dist = os.path.join(CONSOLE_DIR, "dist", "index.html")
        if not os.path.exists(dist):
            print("no dist/ build found; pass --build or --url", file=sys.stderr)
            return 2
        base = f"http://127.0.0.1:{args.port}/"
        log(f"booting vite preview on :{args.port} ...")
        server = subprocess.Popen(
            ["bun", "x", "vite", "preview", "--port", str(args.port),
             "--strictPort", "--host", "127.0.0.1"],
            cwd=CONSOLE_DIR,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        if not wait_http(base):
            server.terminate()
            print("preview server did not come up", file=sys.stderr)
            return 2

    target_q = spec["target"]["query"]
    page_url = base.rstrip("/") + "/?" + target_q
    profiles = spec.get("profiles", {})
    rows = []
    try:
        from playwright.sync_api import sync_playwright
        with sync_playwright() as pw:
            sessions = {}

            def session_for(profile):
                if profile not in sessions:
                    if server is not None and server.poll() is not None:
                        raise RuntimeError(
                            "preview server died before profile launch")
                    log(f"launching browser profile '{profile}' ...")
                    sess = Session(pw, page_url, profile)
                    sessions[profile] = sess
                    for step in profiles.get(profile, {}).get("sessionSteps", []):
                        run = CheckRun(sess, {"steps": [step]})
                        run.run_steps()
                        if run.step_error:
                            # An unsettled world invalidates every scene
                            # in this profile; fail them honestly as
                            # errors instead of measuring a half-load.
                            sess.broken = f"session setup: {run.step_error}"
                            log(f"  session broken: {sess.broken}")
                            break
                return sessions[profile]

            checks = [c for c in spec["checks"]
                      if not only or c["id"] in only]
            last_use = {}
            for i, c in enumerate(checks):
                last_use[c.get("profile", "autoplay")] = i
            for i, check in enumerate(checks):
                profile = check.get("profile", "autoplay")
                sess = session_for(profile)
                row = {"id": check["id"], "label": check.get("label", ""),
                       "weight": check.get("weight", "minor"),
                       "why": check.get("why", ""), "measures": []}
                if check.get("fix"):
                    row["fix"] = check["fix"]
                log(f"check {check['id']} [{row['weight']}] ...")
                if sess.broken:
                    row["status"] = "error"
                    row["error"] = sess.broken
                    rows.append(row)
                    log("  -> error (session broken)")
                    if last_use.get(profile) == i:
                        sess.close()
                        del sessions[profile]
                    continue
                skip_if = check.get("skipIf")
                if skip_if and "absentField" in skip_if:
                    probe = sess.snap()
                    if probe is not None and not field_present(
                            probe, skip_if["absentField"]):
                        row["status"] = "skipped"
                        row["skipReason"] = skip_if.get(
                            "reason",
                            f"{skip_if['absentField']} absent from this tree")
                        rows.append(row)
                        log(f"  -> skipped: {row['skipReason']}")
                        continue
                run = CheckRun(sess, check)
                run.run_steps()
                err0 = len(sess.errors)
                row["measures"] = [eval_measure(run.buckets, m)
                                   for m in check.get("measures", [])]
                if run.step_error:
                    row["status"] = "error"
                    row["error"] = run.step_error
                elif all(m["status"] == "ok" for m in row["measures"]):
                    row["status"] = "ok"
                else:
                    stats = {m["status"] for m in row["measures"]
                             if m["status"] != "ok"}
                    row["status"] = (stats.pop() if len(stats) == 1
                                     else "out")
                row["pageErrors"] = sess.errors[err0:][:3]
                row["series"] = {
                    b: [{"district": s.get("district"),
                         "wind": dig(s, "gains.wind"),
                         "music": dig(s, "gains.music"),
                         "pa": s.get("paLevel"),
                         "master": s.get("masterLevel"),
                         "insideTea": s.get("insideTea"),
                         "ctx": s.get("ctxState")}
                        for s in snaps]
                    for b, snaps in run.buckets.items()
                }
                rows.append(row)
                log(f"  -> {row['status']}")
                if last_use.get(profile) == i:
                    # Free the renderer before another profile boots:
                    # two SwiftShader worlds at once starve this VM.
                    sess.close()
                    del sessions[profile]
            for sess in sessions.values():
                sess.close()
    finally:
        if server and not args.keep_server:
            server.terminate()

    summary = score_checks(rows)
    report = {"target": page_url, "summary": summary, "checks": rows,
              "spec": os.path.basename(args.spec)}
    print_report(report)
    out_path = args.out or os.path.join(HERE, "listen-review-report.json")
    with open(out_path, "w") as f:
        json.dump(report, f, indent=1)
    log(f"report written: {out_path}")
    return 0 if all(r["status"] in ("ok", "skipped") for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
