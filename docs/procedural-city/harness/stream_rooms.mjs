import { chromium } from "playwright";
import fs from "fs";
const CYCLES=Number(process.env.CYCLES||100);
const index=JSON.parse(fs.readFileSync("/home/user/aiverse/apps/console/public/assets/interiors/index.json","utf8"));
const b=await chromium.launch({args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist","--js-flags=--expose-gc"]});
const p=await b.newPage({viewport:{width:900,height:600}}); const cdp=await p.context().newCDPSession(p); await cdp.send("Performance.enable");
const errs=[]; p.on("pageerror",e=>errs.push("PAGEERR "+e.message)); p.on("console",m=>{if(m.type()==="error")errs.push(m.text().slice(0,140))});
const reqs=new Map(); p.on("request",r=>{const u=r.url().split("/assets/")[1]; if(u&&/interiors|library/.test(u)) reqs.set(u,(reqs.get(u)||0)+1)});
const heap=async()=>{await cdp.send("HeapProfiler.collectGarbage"); await cdp.send("HeapProfiler.collectGarbage"); const m=(await cdp.send("Performance.getMetrics")).metrics; return Math.round(m.find(x=>x.name==="JSHeapUsedSize").value/1048576*10)/10;};
const snap=()=>p.evaluate("window.__city3Stream.snapshot()");
const tp=(x,y,z)=>p.evaluate(([x,y,z])=>window.__city3Stream.teleport(x,y,z),[x,y,z]);
const settle=(ms)=>p.waitForTimeout(ms);
await p.goto("http://localhost:5183/?world=city3&streamDebug=1"); await p.waitForFunction("window.__city3Stream",null,{timeout:120000}); await settle(8000);
const s0=await snap(); const h0=await heap();
console.log("BASELINE",JSON.stringify({resident:s0.resident,instanced:s0.scene.instancedMeshes,geoms:s0.memory.geometries,tex:s0.memory.textures,calls:s0.render.calls,heapMB:h0}));
let seed=11; const rnd=()=>{seed=(seed*1664525+1013904223)>>>0; return seed/2**32;};
const rows=[]; let maxRes=0, bad=0, maxCalls=0, firstHeap=null;
for(let k=0;k<CYCLES;k++){
  const r=index[Math.floor(rnd()*index.length)]; await tp(r.center[0]+10,28,r.center[1]+30); await settle(1700);
  const s=await snap(); maxRes=Math.max(maxRes,s.resident.length); maxCalls=Math.max(maxCalls,s.render.calls);
  if(s.scene.instancedMeshes!==s.drawCallsInteriors) bad++;               // what the scene really holds must equal what the handles claim
  if(k===9) firstHeap=await heap();
  if(k%20===19||k===CYCLES-1){ const h=await heap(); rows.push({k:k+1,res:s.resident.length,loads:s.loads,evict:s.evictions,instanced:s.scene.instancedMeshes,geoms:s.memory.geometries,tex:s.memory.textures,calls:s.render.calls,heapMB:h}); }
}
console.log("CYCLES",CYCLES,"| max resident",maxRes,"| max draw calls/frame",maxCalls,"| scene!=handles samples:",bad,"| heap after 10 cycles",firstHeap);
rows.forEach(r=>console.log("  ",JSON.stringify(r)));
await tp(560,60,560); await settle(5000);
const s2=await snap(); const h2=await heap();
console.log("FAR AWAY",JSON.stringify({resident:s2.resident,instanced:s2.scene.instancedMeshes,geoms:s2.memory.geometries,tex:s2.memory.textures,calls:s2.render.calls,loads:s2.loads,evict:s2.evictions,heapMB:h2}));
console.log("layout fetches (each URL once?):",JSON.stringify([...reqs].filter(([u,c])=>c>1)),"| distinct layouts fetched:",[...reqs.keys()].filter(u=>/shop|tea|press/.test(u)).length,"| library fetches:",reqs.get("world-city3-library.glb"));
console.log(errs.filter(e=>!/api|ECONNREFUSED|WebSocket|Failed to load resource|proxy/i.test(e)).join("\n")||"no non-network errors");
await b.close();
