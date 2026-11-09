/** Local experiment host. Start with EMBODIED_TOKEN and EMBODIED_BASE pointing
 * at a running local console. EMBODIED_PLAYWRIGHT_MODULE may locate an existing
 * playwright-core installation; otherwise install playwright-core in this environment.
 * One dedicated browser = one simulation authority; never used as a prod gateway. */
import { ActionLedger } from "./protocol";
const token = process.env.EMBODIED_TOKEN;
if (!token || token.length < 32) throw new Error("EMBODIED_TOKEN must contain at least 32 characters");
const base = new URL(process.env.EMBODIED_BASE ?? "http://127.0.0.1:5184");
if (!["127.0.0.1", "localhost", "[::1]"].includes(base.hostname)) throw new Error("experiment host requires local console");
const { chromium } = await import(process.env.EMBODIED_PLAYWRIGHT_MODULE ?? "playwright-core");
const browser = await chromium.launch({channel:"chrome",headless:true});
const page = await browser.newPage({viewport:{width:1280,height:720}});
base.search = "?world=city3&agent=1";
await page.goto(base.toString());
await page.waitForFunction(() => (window as any).__scout?.ready(), undefined, {timeout:120000});
const session = await page.evaluate(() => (window as any).__scout.snapshot().session);
const ledger = new ActionLedger();
let lastSeen = Date.now();
let expired = false;
const server = Bun.serve({hostname:"127.0.0.1",port:Number(process.env.EMBODIED_PORT ?? 5191),idleTimeout:255,
  async fetch(req) {
    if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("unauthorized",{status:401});
    // No CORS: this bearer service is for the agent process, not arbitrary websites.
    if (req.headers.has("origin")) return new Response("browser-origin requests denied",{status:403});
    if (expired) return new Response("lease expired; restart host for a fresh session",{status:410});
    const current = await page.evaluate(() => (window as any).__scout?.snapshot()?.session).catch(()=>null);
    if (current !== session) return new Response("world session changed",{status:409});
    lastSeen = Date.now();
    const path = new URL(req.url).pathname;
    try {
      if (req.method === "GET" && path === "/heartbeat") return Response.json({session});
      if (req.method === "GET" && path === "/observe") return Response.json(await page.evaluate(() => (window as any).__scout.look()));
      if (req.method === "GET" && path === "/map") return Response.json(await page.evaluate(() => (window as any).__scout.map()));
      if (req.method === "POST" && path === "/act") {
        const text = await req.text(); if (text.length > 4096) return new Response("too large",{status:413});
        const body = JSON.parse(text);
        const result = await ledger.run(body.id,body.action,()=>page.evaluate((action:any)=>(window as any).__scout.act(action),body.action));
        return Response.json({session,result});
      }
      return new Response("not found",{status:404});
    } catch(e) { return Response.json({error:String(e)},{status:400}); }
  }
});
// A lost client must not leave the body walking; a new lease requires a new session.
const timer = setInterval(async()=>{
  if (!expired && Date.now()-lastSeen > 30000) {
    expired=true; await page.evaluate(()=>(window as any).__scout?.act({type:"stop"})).catch(()=>{});
  }
},1000);
console.log(JSON.stringify({host:server.url.toString(),session}));
async function close(){ clearInterval(timer); server.stop(); await browser.close(); process.exit(0); }
process.on("SIGINT",close); process.on("SIGTERM",close);
