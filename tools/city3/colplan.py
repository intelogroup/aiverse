"""Top-down sheet of hero rooms: walls (grey), furniture boxes (red), seats (green), approach points (blue), door path (yellow).  python3 colplan.py <id> [<id> ...] -> out/colplan.png"""
import json, math, sys
from PIL import Image, ImageDraw
HERE=__import__("os").path.dirname(__import__("os").path.abspath(__file__)); OUT=f"{HERE}/out"
ids=sys.argv[1:]; H={r["id"]:r for r in json.load(open(f"{OUT}/heroes.json"))}; A=json.load(open(f"{OUT}/hero-anchors.json"))["anchors"]; S=40
rows=[]
for hid in ids:
    r=H[hid]; x0,z0,x1,z1=r["rect"]; W,D=x1-x0,z1-z0; doc=json.load(open(f"{OUT}/interiors/{hid}.col.json"))
    im=Image.new("RGB",(int(W*S)+40,int(D*S)+40),(245,245,245)); d=ImageDraw.Draw(im); P=lambda x,z:((x-x0)*S+20,(z-z0)*S+20)
    d.rectangle([*P(x0,z0),*P(x1,z1)],fill=(190,190,190)); d.rectangle([*P(x0+.3,z0+.3),*P(x1-.3,z1-.3)],fill=(250,250,250))
    dx,dz=r["door"]; ix,iz={"S":(0,-1),"N":(0,1),"E":(-1,0),"W":(1,0)}[r["front"]]; tx,tz=-iz,ix
    poly=[(dx+tx*s+ix*k,dz+tz*s+iz*k) for s,k in ((-.85,-.5),(.85,-.5),(.85,3),(-.85,3))]; d.polygon([P(*p) for p in poly],fill=(255,235,120))
    for (cx,cz,hx,hz,y0_,y1_,rot) in doc["boxes"]:
        c,s_=math.cos(rot),math.sin(rot); pts=[]
        for lx,lz in ((-hx,-hz),(hx,-hz),(hx,hz),(-hx,hz)): pts.append(P(cx+lx*c+lz*s_,cz-lx*s_+lz*c))
        d.polygon(pts,fill=(225,90,90),outline=(120,0,0))
    for a in A:
        if a["building"]!=hid: continue
        for (p,col) in ((a["seat"],(30,170,30)),(a["approach"],(30,60,230))): q=P(*p); d.ellipse([q[0]-4,q[1]-4,q[0]+4,q[1]+4],fill=col)
        d.line([*P(*a["seat"]),*P(*a["approach"])],fill=(120,120,120))
    d.text((24,2),f"{hid} {r['template']} {W:.0f}x{D:.0f} front={r['front']} boxes={len(doc['boxes'])}",fill=(0,0,0)); rows.append(im)
Wd=max(i.width for i in rows); Hd=sum(i.height for i in rows); sheet=Image.new("RGB",(Wd,Hd),(255,255,255)); y=0
for i in rows: sheet.paste(i,(0,y)); y+=i.height
sheet.save(f"{OUT}/colplan.png"); print(sheet.size)
