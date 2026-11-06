import { chromium } from "playwright";
const b=await chromium.launch({args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"]});
const p=await b.newPage({viewport:{width:480,height:320}}); const errs=[];
p.on("pageerror",e=>errs.push("PAGEERR "+e.message)); p.on("console",m=>{if(m.type()==="error")errs.push(m.text().slice(0,160))});
await p.goto("http://localhost:5183/?embody=1&bodyDebug=1"); await p.waitForFunction("window.__embody&&window.__bodyLog&&window.__bodyLog.length>5",null,{timeout:120000});
const last=()=>p.evaluate(()=>{const l=window.__bodyLog.slice(-1)[0];return {t:l.t,v:l.v[0],h:l.h[0],p:l.p[0],turn:l.turn[0],n:window.__bodyLog.length}});
await p.evaluate(()=>window.__embody.issue(0,{skill:"go_to",target:[6,3]}));
let phase=0, order=null, t0=Date.now(), turned=false, maxStep=0, prevH=null, resumed=null;
while(Date.now()-t0<170000){
  await p.waitForTimeout(2500); const s=await last();
  if(phase===0&&s.v>0.85){ const tx=s.p[0]-Math.sin(s.h)*5, tz=s.p[1]-Math.cos(s.h)*5; const r=Math.hypot(tx,tz); const k=r>8.4?8.4/r:1;
    await p.evaluate(([x,z])=>{window.__embody.issue(0,{skill:"stop"});window.__embody.issue(0,{skill:"go_to",target:[x,z]})},[tx*k,tz*k]); phase=1; order=s.t; console.log("ORDER at sim t=",s.t.toFixed(2),"speed",s.v.toFixed(2),"->",(tx*k).toFixed(1),(tz*k).toFixed(1)); }
  if(phase===1&&s.turn!==0) turned=true;
  if(phase===1&&turned&&s.turn===0&&s.t>order+1) { resumed=s; break; }
}
const log=await p.evaluate(()=>window.__bodyLog.map(l=>({t:l.t,dt:l.dt,h:l.h[0],v:l.v[0],turn:l.turn[0]})));
let m=0,big=0; for(let i=1;i<log.length;i++){ if(order!==null&&log[i].t<order) continue; const d=Math.abs(Math.atan2(Math.sin(log[i].h-log[i-1].h),Math.cos(log[i].h-log[i-1].h)))/log[i].dt*180/Math.PI; m=Math.max(m,d); if(d>260)big++ }
console.log(JSON.stringify({orderedAtSimT:order,sawTurnClip:turned,turnFrames:log.filter(l=>l.turn!==0).length,maxHeadingRateAfterOrder_degPerS:+m.toFixed(0),framesOver260:big,simSeconds:+log[log.length-1].t.toFixed(1),resumedWalking:!!resumed}));
console.log(errs.filter(e=>!/api|ECONNREFUSED|WebSocket|Failed to load resource|proxy/i.test(e)).join("\n")||"no non-network errors");
await b.close();
