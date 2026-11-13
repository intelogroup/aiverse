// Minimal static server for the renderer experiments (bun).
// Serves the renderer-tests dir so /rig/*, /assets/* resolve.
const root = new URL("..", import.meta.url).pathname;
const MIME: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".glb": "model/gltf-binary",
  ".png": "image/png",
};
Bun.serve({
  port: 5321,
  async fetch(req) {
    const url = new URL(req.url);
    const path = root + decodeURIComponent(url.pathname.slice(1));
    const f = Bun.file(path);
    if (!(await f.exists())) return new Response("nf", { status: 404 });
    const ext = path.slice(path.lastIndexOf("."));
    return new Response(f, {
      headers: { "Content-Type": MIME[ext] ?? "application/octet-stream" },
    });
  },
});
console.log("serving on :5321 root=" + root);
