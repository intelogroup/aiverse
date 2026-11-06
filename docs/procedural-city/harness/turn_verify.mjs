import { chromium } from "playwright"; import http from "http"; import fs from "fs"; import path from "path";
const root=process.cwd(); const types={".js":"text/javascript",".html":"text/html",".glb":"model/gltf-binary"};
const srv=http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split("?")[0]);const f=path.join(root,u==="/"?"turn_verify.html":u);fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end();return;}res.writeHead(200,{"content-type":types[path.extname(f)]||"application/octet-stream"});res.end(d);});}).listen(8126);
const b=await chromium.launch({args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
const p=await b.newPage(); p.on("pageerror",e=>console.log("PAGEERR",e.message));
for(const [v,deg] of [["legacy",90],["new",90],["legacy",180],["new",180],["new",-90]]){
  await p.goto(`http://localhost:8126/?v=${v}&deg=${deg}`); await p.waitForFunction("window.__out",null,{timeout:60000});
  const o=await p.evaluate("window.__out"); console.log(JSON.stringify({variant:o.variant,targetDeg:o.targetDeg,finalHeading:o.finalHeading,finalPelvis:o.finalPelvis,turningSeconds:o.turningSeconds,footSlideM:o.slideM,slideMPerDegTurned:o.slidePerDegM,contactFrames:o.contactFrames,pelvisVsHeading:{max:o.maxPelvisVsHeadingDeg,mean:o.meanPelvisVsHeadingDeg}}));
}
await b.close(); srv.close();
