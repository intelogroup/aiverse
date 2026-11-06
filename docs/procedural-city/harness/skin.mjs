import { chromium } from "playwright";
import http from "http"; import fs from "fs"; import path from "path";
const root=process.cwd();
const types={".js":"text/javascript",".mjs":"text/javascript",".html":"text/html",".glb":"model/gltf-binary",".json":"application/json"};
const srv=http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split("?")[0]);const f=path.join(root,u==="/"?"skin.html":u);fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end();return;}res.writeHead(200,{"content-type":types[path.extname(f)]||"application/octet-stream"});res.end(d);});}).listen(8123);
const b=await chromium.launch({args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"]});
const p=await b.newPage(); p.on("pageerror",e=>console.log("PAGEERR",e.message)); p.on("console",m=>{if(m.type()==="error")console.log("CONSOLE",m.text())});
for(const body of (process.env.BODIES||"cast-bodyblock").split(",")){
  await p.goto(`http://localhost:8123/?body=${body}&ns=${process.env.NS||"32,100,300"}`);
  await p.waitForFunction("window.__out",null,{timeout:280000});
  console.log(JSON.stringify(await p.evaluate("window.__out"),null,1));
}
await b.close(); srv.close();
