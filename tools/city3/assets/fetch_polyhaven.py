import json,os,sys,urllib.request,hashlib
UA={"User-Agent":"aiverse-city3-builder/1.0"}
def get(url): return urllib.request.urlopen(urllib.request.Request(url,headers=UA),timeout=60)
def save(url,path): open(path,"wb").write(get(url).read())
IDS=sys.argv[1:]
for i in IDS:
    f=json.load(get(f"https://api.polyhaven.com/files/{i}"))
    if "gltf" not in f: print(f"{i:32s} no glTF download — skipped"); continue
    g=f["gltf"]["1k"]["gltf"]; os.makedirs(i,exist_ok=True)
    todo=[(f"{i}/{os.path.basename(g['url'])}",g["url"],g.get("md5"))]+[(f"{i}/{k}",v["url"],v.get("md5")) for k,v in g["include"].items()]
    tot=0
    for path,url,md5 in todo:
        os.makedirs(os.path.dirname(path),exist_ok=True)
        if not os.path.exists(path): save(url,path)
        data=open(path,"rb").read(); tot+=len(data)
        if md5 and hashlib.md5(data).hexdigest()!=md5: print("MD5 MISMATCH",path)
    info=json.load(get(f"https://api.polyhaven.com/info/{i}"))
    json.dump({"id":i,"name":info.get("name"),"authors":info.get("authors"),"license":"CC0","source":f"https://polyhaven.com/a/{i}","polycount":info.get("polycount"),"dimensions":info.get("dimensions")},open(f"{i}/meta.json","w"),indent=1)
    print(f"{i:32s} {tot//1024:6d} KB  polycount={info.get('polycount')} dims={info.get('dimensions')}")
