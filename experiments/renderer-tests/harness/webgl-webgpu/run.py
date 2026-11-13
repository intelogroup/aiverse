import os
FX=os.environ.get('FX','')
import asyncio,sys,json,base64,subprocess,time
from playwright.async_api import async_playwright
glbs=sys.argv[1:] or ['cast-jim.glb']
async def main():
    srv=subprocess.Popen(['python3','-m','http.server','8765'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL);time.sleep(1)
    try:
        async with async_playwright() as p:
            b=await p.chromium.launch(channel='chrome',headless=True,args=['--enable-unsafe-webgpu','--enable-features=WebGPU','--ignore-gpu-blocklist'])
            for glb in glbs:
              for path in ['webgl','webgpu']:
                pg=await b.new_page(viewport={'width':768,'height':768});logs=[]
                pg.on('console',lambda m:logs.append(m.text[:150]))
                t0=time.time();await pg.goto('http://127.0.0.1:8765/index.html?r='+path+'&glb='+glb+'&fx='+FX)
                try: await pg.wait_for_function('window.__out',timeout=120000)
                except Exception as e: print(path,'timeout',logs[:3]);continue
                o=await pg.evaluate('window.__out');o['pageTotalMs']=round((time.time()-t0)*1000);cam=o.pop('cam',None)
                if cam and path=='webgl': json.dump(cam,open(f'cam-{glb[:-4]}.json','w'))
                d=o.pop('dataUrl',None)
                if d: open(f'b-{glb[:-4]}-{path}.png','wb').write(base64.b64decode(d.split(',')[1]))
                print(json.dumps(o));
                if o.get('error'): print(logs[:4])
                await pg.close()
            await b.close()
    finally: srv.terminate()
asyncio.run(main())
