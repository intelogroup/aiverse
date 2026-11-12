#!/usr/bin/env python3
"""Probe: find Chromium flag sets that yield (a) WebGL SwiftShader string,
(b) a non-null WebGPU adapter (expected: SwiftShader Vulkan fallback)."""
import asyncio, json, glob
from playwright.async_api import async_playwright

FULL = glob.glob("/home/hatch/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome")[0]

FLAG_SETS = {
    "webgl-default": [],
    "webgpu-a": ["--enable-unsafe-webgpu", "--use-angle=vulkan",
                 "--enable-features=Vulkan,VulkanFromANGLE,DefaultANGLEVulkan",
                 "--disable-vulkan-surface"],
    "webgpu-b": ["--enable-unsafe-webgpu", "--use-vulkan=swiftshader",
                 "--enable-features=Vulkan", "--disable-vulkan-surface"],
    "webgpu-c": ["--enable-unsafe-webgpu"],
}

async def main():
    async with async_playwright() as pw:
        for name, args in FLAG_SETS.items():
            try:
                browser = await pw.chromium.launch(
                    executable_path=FULL, headless=True, args=args)
                page = await browser.new_page()
                await page.goto("http://127.0.0.1:5321/rig/probe.html")
                res = await page.evaluate("window.__probe")
                print(name, "=>", json.dumps(res))
                await browser.close()
            except Exception as e:
                print(name, "=> LAUNCH/RUN ERROR:", str(e)[:300])

asyncio.run(main())
