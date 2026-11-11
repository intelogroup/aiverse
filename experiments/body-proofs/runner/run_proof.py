#!/usr/bin/env python3
"""Consolidated body-proof driver — one parametrized runner for every body.

Consolidates the three per-body shoot.py/measure.py pairs from the
2026-11-11 roster-clearing pass (cipher/eve/skeleton lanes) into a single
script: body registry id in -> hero frames + measurements out.

It drives the stage page (runner/body-proof.html + runner/bodyProof.tsx,
copied into a scratch checkout of apps/console and served by vite — see
../README.md "How to run") in headless Chromium with SwiftShader, exactly
the rig the original proofs used:

  ?view=front  Idle still  -> <body>-front-idle.png  + __MEASURE (front)
  ?view=side   Idle still  -> <body>-side-idle.png
  ?view=walk   Walk clip   -> burst/walk-0..7.png across one cycle;
               burst frame 2 is copied to <body>-walk-stride.png (the
               mid-stride pick the original verdicts used) and __MEASURE
               is read on the walk view too.

All measurements are printed as JSON lines and also written to
<out>/measurements.json. A pass is a human verdict against the registry
numbers (README "What a pass means") — this script never grades.

Usage:
  python3 run_proof.py <body-id> [--out DIR] [--base URL] [--stride-index N]

  <body-id>       registry id, e.g. cipher, eve, skeleton-warrior
  --out DIR       frame output dir (default: ./frames)
  --base URL      stage page URL (default http://127.0.0.1:5199/body-proof.html)
  --stride-index  burst frame copied as the walk-stride hero (default 2)
"""
import argparse
import asyncio
import json
import os
import shutil
import sys

from playwright.async_api import async_playwright

BURST_FRAMES = 8
BURST_INTERVAL_MS = 150


async def shoot(page, base, body, view, out, name, settle_ms=1200):
    await page.goto(f"{base}?body={body}&view={view}", wait_until="domcontentloaded", timeout=60000)
    try:
        await page.wait_for_function("window.__PROOF_READY === true", timeout=90000)
        ready = True
    except Exception:
        ready = False
    err = await page.evaluate("window.__PROOF_ERROR ?? null")
    if err:
        print(f"FATAL: {err}", flush=True)
        sys.exit(2)
    await page.wait_for_timeout(settle_ms)
    measure = await page.evaluate("window.__MEASURE ?? null")
    await page.screenshot(path=os.path.join(out, name))
    print(f"shot {name} ready={ready} measure={json.dumps(measure)}", flush=True)
    return measure


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("body")
    ap.add_argument("--out", default="./frames")
    ap.add_argument("--base", default="http://127.0.0.1:5199/body-proof.html")
    ap.add_argument("--stride-index", type=int, default=2)
    args = ap.parse_args()

    os.makedirs(os.path.join(args.out, "burst"), exist_ok=True)
    measures = {}

    async with async_playwright() as pw:
        browser = await pw.chromium.launch(
            args=["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"]
        )
        page = await browser.new_page(viewport={"width": 1000, "height": 900})
        page.on("console", lambda m: print("  [console]", m.type, m.text[:200], flush=True))
        page.on("pageerror", lambda e: print("  [pageerror]", str(e)[:300], flush=True))

        measures["front"] = await shoot(page, args.base, args.body, "front", args.out, f"{args.body}-front-idle.png")
        measures["side"] = await shoot(page, args.base, args.body, "side", args.out, f"{args.body}-side-idle.png")

        # Walk: burst across a full cycle so one frame lands mid-stride.
        await page.goto(f"{args.base}?body={args.body}&view=walk", wait_until="domcontentloaded", timeout=60000)
        try:
            await page.wait_for_function("window.__PROOF_READY === true", timeout=90000)
        except Exception:
            print("walk: ready flag never set", flush=True)
        await page.wait_for_timeout(800)  # let the walk weight reach 1
        measures["walk"] = await page.evaluate("window.__MEASURE ?? null")
        clip = (measures["walk"] or {}).get("clip")
        print(f"walk clip={clip} measure={json.dumps(measures['walk'])}", flush=True)
        for i in range(BURST_FRAMES):
            await page.screenshot(path=os.path.join(args.out, "burst", f"walk-{i}.png"))
            await page.wait_for_timeout(BURST_INTERVAL_MS)
        print("walk burst done", flush=True)
        await browser.close()

    stride_src = os.path.join(args.out, "burst", f"walk-{args.stride_index}.png")
    stride_dst = os.path.join(args.out, f"{args.body}-walk-stride.png")
    shutil.copyfile(stride_src, stride_dst)
    print(f"walk-stride hero: burst frame {args.stride_index} -> {stride_dst}", flush=True)

    with open(os.path.join(args.out, "measurements.json"), "w") as fh:
        json.dump(measures, fh, indent=2)
    print(f"measurements written to {os.path.join(args.out, 'measurements.json')}", flush=True)


asyncio.run(main())
