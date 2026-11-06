import { chromium } from "playwright"; import http from "http"; import fs from "fs"; import path from "path";
const root=process.cwd(); const types={".js":"text/javascript",".html":"text/html",".glb":"model/gltf-binary",".json":"application/json"};
const srv=http.createServer((req,res)=>{const u=decodeURIComponent(req.url.split("?")[0]);const f=path.join(root,u==="/"?"city.html":u);fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);res.end();return;}res.writeHead(200,{"content-type":types[path.extname(f)]||"application/octet-stream"});res.end(d);});}).listen(8124);
const b=await chromium.launch({args:["--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader","--ignore-gpu-blocklist"]});
const p=await b.newPage(); p.on("pageerror",e=>console.log("PAGEERR",e.message)); p.on("console",m=>{if(m.type()==="error")console.log("CONSOLE",m.text())});
const url=process.env.Q||"v=%7B%7D"; await p.goto("http://localhost:8124/?"+url); await p.waitForFunction("window.__out",null,{timeout:120000});
const o=await p.evaluate("window.__out");
for(const [k,v] of Object.entries(o.shots)){fs.writeFileSync(`../city3/out/${process.env.PFX||'d'}_${k}.png`,Buffer.from(v.split(",")[1],"base64"));}
delete o.shots; console.log(JSON.stringify(o)); await b.close(); srv.close();
