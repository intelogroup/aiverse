import { chromium } from "playwright"; import http from "http"; import fs from "fs"; import path from "path";
const root=process.cwd(); const types={".js":"text/javascript",".html":"text/html",".glb":"model/gltf-binary"};
const srv=http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split("?")[0]);const f=path.join(root,u==="/"?"tv4.html":u);fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end();return;}res.writeHead(200,{"content-type":types[path.extname(f)]||"application/octet-stream"});res.end(d);});}).listen(8130);
const b=await chromium.launch({args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
const p=await b.newPage(); p.on("pageerror",e=>console.log("PAGEERR",e.message));
for(const clip of ["TurnLeft90","TurnRight90"]){ await p.goto("http://localhost:8130/?clip="+clip); await p.waitForFunction("window.__out",null,{timeout:60000}); console.log(JSON.stringify(await p.evaluate("window.__out"))); }
await b.close(); srv.close();
