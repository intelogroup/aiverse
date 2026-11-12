#!/usr/bin/env python3
"""Drive the renderer rig: one backend+subject per run, warm captures x3.
Usage: capture.py <backend> <subject> <outprefix>
Writes <outprefix>-1.png (first timed capture) and <outprefix>.json (info+timings)."""
import asyncio, base64, json, sys, glob
from playwright.async_api import async_playwright

FULL = glob.glob("/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome")[0]
WEBGPU_ARGS = ["--enable-unsafe-webgpu", "--use-vulkan=swiftshader",
               "--enable-features=Vulkan", "--disable-vulkan-surface"]

async def main():
    backend, subject, outprefix = sys.argv[1], sys.argv[2], sys.argv[3]
    args = WEBGPU_ARGS if backend == "webgpu" else []
    console_msgs = []
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=FULL, headless=True, args=args)
        page = await browser.new_page(viewport={"width": 512, "height": 288})
        page.on("console", lambda m: console_msgs.append(f"{m.type}: {m.text[:200]}"))
        page.on("pageerror", lambda e: console_msgs.append(f"pageerror: {str(e)[:300]}"))
        await page.goto(f"http://127.0.0.1:5321/rig/page-{backend}.html?backend={backend}&subject={subject}")
        await page.wait_for_function("window.__rigReady === true", timeout=600_000)
        info = await page.evaluate("window.__rig.info")
        caps = []
        for i in range(3):
            caps.append(await page.evaluate("window.__rig.capture()"))
        with open(f"{outprefix}-1.png", "wb") as f:
            f.write(base64.b64decode(caps[0]["pngB64"]))
        for c in caps:
            c.pop("pngB64")
        result = {"info": info, "captures": caps, "console": console_msgs[-12:]}
        with open(f"{outprefix}.json", "w") as f:
            json.dump(result, f, indent=1)
        print(json.dumps(result, indent=1)[:2500])
        await browser.close()

asyncio.run(main())
