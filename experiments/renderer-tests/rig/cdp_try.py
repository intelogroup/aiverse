#!/usr/bin/env python3
"""Bounded attempt: WebGPU canvas + CDP page.screenshot readback.
In-page readbacks failed two ways on this host (canvas toBlob = black;
RT readRenderTargetPixelsAsync = mapAsync Instance error). CDP surface
capture is the last readback avenue. Usage: cdp_try.py <subject> <outprefix>"""
import asyncio, json, sys, glob, time
from playwright.async_api import async_playwright

FULL = glob.glob("/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome")[0]
ARGS = ["--enable-unsafe-webgpu", "--use-vulkan=swiftshader",
        "--enable-features=Vulkan", "--disable-vulkan-surface"]

async def main():
    subject, outprefix = sys.argv[1], sys.argv[2]
    async with async_playwright() as pw:
        browser = await pw.chromium.launch(executable_path=FULL, headless=True, args=ARGS)
        page = await browser.new_page(viewport={"width": 512, "height": 288})
        await page.goto(f"http://127.0.0.1:5321/rig/page-webgpu.html?backend=webgpu&subject={subject}")
        await page.wait_for_function("window.__rigReady === true", timeout=600_000)
        info = await page.evaluate("window.__rig.info")
        for _ in range(2):
            await page.evaluate("window.__rig.renderOnly()")
        caps = []
        for i in range(3):
            t0 = time.time()
            render_ms = await page.evaluate("window.__rig.renderOnly()")
            shot = await page.screenshot(type="png")
            total_ms = (time.time() - t0) * 1000
            if i == 0:
                with open(f"{outprefix}-1.png", "wb") as f:
                    f.write(shot)
            caps.append({"renderMs": render_ms, "totalMs": round(total_ms, 1), "bytes": len(shot)})
        print(json.dumps({"info": info, "captures": caps}, indent=1))
        with open(f"{outprefix}.json", "w") as f:
            json.dump({"info": info, "captures": caps, "method": "canvas + CDP page.screenshot"}, f, indent=1)
        await browser.close()

asyncio.run(main())
