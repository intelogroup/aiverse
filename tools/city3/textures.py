import numpy as np, os
from PIL import Image
OUT="tex"; os.makedirs(OUT,exist_ok=True)
rng=np.random.default_rng(7)
def noise(h,w,beta=1.6,seed=None):
    r=np.random.default_rng(seed) if seed is not None else rng
    f=np.fft.fft2(r.standard_normal((h,w)))
    fy=np.fft.fftfreq(h)[:,None]; fx=np.fft.fftfreq(w)[None,:]
    k=np.sqrt(fx**2+fy**2); k[0,0]=1; f=f/(k**beta); f[0,0]=0
    n=np.real(np.fft.ifft2(f)); n=(n-n.mean())/(n.std()+1e-9); return n
def save(a,name,flip=True,q=88):
    a=np.clip(a,0,255).astype(np.uint8)
    if flip: a=a[::-1]
    Image.fromarray(a).save(f"{OUT}/{name}.jpg",quality=q)
def col(h): h=h.lstrip("#"); return np.array([int(h[i:i+2],16) for i in (0,2,4)],float)
def fill(img,x0,y0,x1,y1,c,ppm,a=1.0):   # metres, y-up
    X0,X1=int(x0*ppm),int(x1*ppm); Y0,Y1=int(y0*ppm),int(y1*ppm)
    img[Y0:Y1,X0:X1]=img[Y0:Y1,X0:X1]*(1-a)+np.array(c)*a
def shade(base,n,amt=0.07): return base[None,None,:]*(1+amt*n[...,None])

import json
from PIL import Image as _I, ImageDraw, ImageFont
PPM=96
ACC={"sand":"#a8873f","ochre":"#6b3b24","white":"#b9a98a","rose":"#8a4a3a","blue":"#5b4a3a"}
PLASTER={"sand":"#dcc08f","ochre":"#d4a65a","white":"#ece6d8","rose":"#cf8a69","blue":"#8fb0bf"}
def streaks(H,W,amt=0.10):
    a=noise(6,W,0.4); a=(a-a.min())/(a.max()-a.min()+1e-9)
    big=np.array(_I.fromarray((a*255).astype(np.uint8)).resize((W,H),_I.BICUBIC),float)/255
    fade=np.linspace(0.2,1.0,H)[::-1][:,None]          # stronger toward the bottom of each tile (y-up rows: row 0 = bottom)
    return 1-amt*big*fade
def base(plaster,h_m,seed):
    W,H=int(4*PPM),int(h_m*PPM); n=noise(H,W,1.4,seed)
    img=shade(col(plaster),n,0.06).copy(); img*=streaks(H,W)[...,None]
    img*=(1+0.02*noise(H,W,0.8,seed+1)[...,None]); return img
def upper_a(pl):
    img=base(pl,3.5,11); H=img.shape[0]
    fill(img,1.40,0.95,2.60,2.55,col("#3a3a40"),PPM)
    gh=int(1.5*PPM); gy=np.linspace(0,1,gh)[:,None,None]
    glass=col("#243447")*(1-gy)+col("#7194b0")*gy
    y0,y1,x0,x1=int(1.05*PPM),int(2.45*PPM),int(1.50*PPM),int(2.50*PPM)
    img[y0:y1,x0:x1]=np.broadcast_to(glass[int(0.1*PPM):int(0.1*PPM)+(y1-y0)],(y1-y0,x1-x0,3))
    img[y1-6:y1,x0:x1]*=0.55; img[y0:y1,x0:x0+5]*=0.7                 # inner reveal shadow
    fill(img,1.97,1.05,2.03,2.45,col("#3a3a40"),PPM); fill(img,1.5,1.72,2.5,1.78,col("#3a3a40"),PPM)
    fill(img,1.30,2.55,2.70,2.66,col("#c9b79a"),PPM)
    fill(img,0,3.38,4,3.5,col(pl)*0.82,PPM)
    return img
def upper_b(pl):
    img=base(pl,3.5,12); W=img.shape[1]; H=img.shape[0]
    ys=np.arange(H)[:,None]/PPM; xs=np.arange(W)[None,:]/PPM; cx=2.0; r=0.62
    op=((np.abs(xs-cx)<r)&(ys>0.15)&(ys<2.0))|(((xs-cx)**2+(ys-2.0)**2<r*r)&(ys>=2.0))
    fr=((np.abs(xs-cx)<r+0.1)&(ys>0.15)&(ys<2.0))|(((xs-cx)**2+(ys-2.0)**2<(r+0.1)**2)&(ys>=2.0))
    img=np.where((fr&~op)[...,None],col("#efe8d8"),img)
    gy=np.clip(ys/2.6,0,1); glass=col("#243447")[None,None,:]*(1-gy[...,None])+col("#7aa0bc")[None,None,:]*gy[...,None]
    img=np.where(op[...,None],glass*np.ones((1,W,1)),img)
    for xm in (cx-0.0,): img=np.where((op&(np.abs(xs-xm)<0.025))[...,None],col("#efe8d8"),img)
    for ym in (0.9,1.5): img=np.where((op&(np.abs(ys-ym)<0.025))[...,None],col("#efe8d8"),img)
    fill(img,0,3.38,4,3.5,col(pl)*0.82,PPM); return img
def shop_a(pl,ac):
    img=base(pl,4.2,13); W=img.shape[1]; H=img.shape[0]
    fill(img,0,0,4,0.45,col("#8d8173"),PPM); fill(img,0,3.45,4,4.1,col(ac),PPM); fill(img,0,3.38,4,3.45,col("#d8cdb8"),PPM); fill(img,0,4.1,4,4.2,col(pl)*0.82,PPM)
    cx=2.0; r=1.3; ys=np.arange(H)[:,None]/PPM; xs=np.arange(W)[None,:]/PPM
    ins=((np.abs(xs-cx)<r)&(ys>0.45)&(ys<1.7))|(((xs-cx)**2+(ys-1.7)**2<r*r)&(ys>=1.7))
    dark=np.clip(1-((xs-cx)**2/(r*r)),0,1); glow=col("#f2c77a")*(0.45+0.4*np.clip((ys-0.45)/1.4,0,1))[...,None]*np.ones((1,W,1))
    img=np.where(ins[...,None],glow*(0.35+0.65*dark[...,None])+col("#2b1d14")*0.25,img)
    arch=(((np.abs(xs-cx)<r+0.12)&(ys>0.45)&(ys<1.7))|(((xs-cx)**2+(ys-1.7)**2<(r+0.12)**2)&(ys>=1.7)))&~ins
    return np.where(arch[...,None],col("#d8cdb8"),img)
def shop_b(pl,ac):
    img=base(pl,4.2,14)
    fill(img,0,0,4,0.45,col("#8d8173"),PPM); fill(img,0,3.45,4,4.1,col(ac),PPM); fill(img,0,3.38,4,3.45,col("#d8cdb8"),PPM); fill(img,0,4.1,4,4.2,col(pl)*0.82,PPM)
    fill(img,0.28,0.78,3.72,3.12,col("#3a2a20"),PPM)                      # frame
    W=img.shape[1]; ys=np.linspace(0,1,int(2.2*PPM))[:,None,None]
    warm=col("#f0c070")*(0.5+0.4*ys)+col("#2b1d14")*0.2
    y0,y1,x0,x1=int(0.9*PPM),int(0.9*PPM)+warm.shape[0],int(0.4*PPM),int(3.6*PPM)
    img[y0:y1,x0:x1]=np.broadcast_to(warm,(y1-y0,x1-x0,3))
    for sy in (1.5,2.1,2.7):                                               # shelf lines + goods
        fill(img,0.4,sy,3.6,sy+0.05,col("#5a3a22"),PPM)
        for gx in np.arange(0.5,3.5,0.28):
            c=[col("#a3392e"),col("#c9a227"),col("#2e6b3a"),col("#2f6f8f"),col("#e8e0cc")][int(rng.integers(0,5))]
            fill(img,gx,sy+0.05,gx+0.16,sy+0.05+0.16+0.12*rng.random(),c,PPM)
    for mx in (1.35,2.65): fill(img,mx,0.9,mx+0.05,3.1,col("#3a2a20"),PPM)
    fill(img,0.2,0.62,3.8,0.78,col("#d8cdb8"),PPM); return img
def plain_c(pl,ac):
    img=base(pl,4.2,15)
    fill(img,0,0,4,0.45,col("#8d8173"),PPM); fill(img,0,3.45,4,4.1,col(ac),PPM); fill(img,0,3.38,4,3.45,col("#d8cdb8"),PPM); fill(img,0,4.1,4,4.2,col(pl)*0.82,PPM); return img
ATL={}
GUT=6
def plaster_mottle():
    """ambientCG Plaster002 diffuse as a pure multiplier field — the facades selection's verified
    recipe: per-channel mean-normalised, clipped to the darkening range, gain-compensated so the
    field averages 1.0. The strip keeps the wall colour (it IS the palette); the plaster only
    clouds it. Baked into the strips because a texture x texture multiply cannot survive glTF
    export (probed on Blender 5.2.3: the exporter silently drops the second texture). One field
    tile = 3.5 m at strip PPM; the atlas is a vertical stack of wall tiles, so the field runs
    continuously up the stack (u = metres along the bay, v = metres up the stack)."""
    src=np.array(Image.open("assets/ambientcg/Plaster002/Plaster002_1K-JPG_Color.jpg").convert("RGB"),float)/255.0
    n=src/src.mean(axis=(0,1),keepdims=True); c=np.clip(n,0,1); m=c*(1.0/c.mean())
    px=int(3.5*PPM)
    return np.array(Image.fromarray((np.clip(m[::-1],0,1)*255).astype(np.uint8)).resize((px,px),Image.BILINEAR),float)/255.0   # row 0 = bottom, atlas-style; clip before the uint8 cast — the gain pushes highlights to 1.016 and an unclipped cast wraps them to black
MOT=plaster_mottle()
def mottle_field(h,w): return np.tile(MOT,(int(np.ceil(h/MOT.shape[0])),int(np.ceil(w/MOT.shape[1])),1))[:h,:w]
for k in PLASTER:
    tiles=[("shopA",shop_a(PLASTER[k],ACC[k])),("shopB",shop_b(PLASTER[k],ACC[k])),("plain",plain_c(PLASTER[k],ACC[k])),("upA",upper_a(PLASTER[k])),("upB",upper_b(PLASTER[k]))]
    AH=2048; atlas=np.zeros((AH,int(4*PPM),3)); atlas[:]=col(PLASTER[k]); y=0; rngs={}
    for name,t in tiles:
        h=t.shape[0]; atlas[y:y+h]=t; rngs[name]=[(y+2)/AH,(y+h-2)/AH]; y+=h+GUT
    save(atlas*mottle_field(AH,int(4*PPM)),f"facade_{k}"); ATL=rngs
json.dump(ATL,open("atlas.json","w")); print("atlas",ATL, "used px",y)

def interior_wall():
    W,H=int(4*PPM),int(4.2*PPM); n=noise(H,W,1.3,21); img=shade(col("#eadcc0"),n,0.05).copy()
    wain=int(1.15*PPM); wood=shade(col("#6a4428"),noise(wain,W,1.0,22),0.10)
    img[:wain]=wood
    for x in range(0,W,int(0.5*PPM)): img[:wain,x:x+2]*=0.7                    # panel joints
    img[wain-6:wain+2]=col("#4a2e1a"); img[wain+2:wain+5]=col("#f1e6cc")        # dado rail + shadow line
    img[int(3.5*PPM):int(3.5*PPM)+4]=col("#6a4428")                              # picture rail
    img[:int(0.12*PPM)]=col("#2f1d10")                                           # skirting
    save(img,"interior_wall")
def wood_floor():
    S=512; img=np.zeros((S,S,3)); n=noise(S,S,1.0,31); pw=32
    for i in range(S//pw):
        base_=col("#8a5a34")*(0.78+0.35*rng.random()); off=int(rng.integers(0,S))
        for y in range(0,S,128):                                                  # staggered boards
            img[y:y+128,i*pw:(i+1)*pw]=base_*(0.92+0.16*rng.random())
        img[:,i*pw:i*pw+2]*=0.55
    for y in range(0,S,128): img[y:y+2]*=0.7
    img*=(1+0.06*n[...,None]); save(img,"wood_floor")
def rug():
    S=512; img=np.zeros((S,S,3)); img[:]=col("#9a2e2e"); yy,xx=np.mgrid[0:S,0:S]; u=np.abs(xx-S/2)/(S/2); v=np.abs(yy-S/2)/(S/2)
    def band(a,b,c): 
        m=(np.maximum(u,v)>=a)&(np.maximum(u,v)<b); img[m]=col(c)
    band(0.0,0.06,"#e8d9a8"); band(0.84,0.9,"#e8d9a8"); band(0.9,0.96,"#1f6f78"); band(0.96,1.01,"#e8d9a8")
    dia=(u+v)<0.55; img[dia]=col("#1f6f78"); dia2=(u+v)<0.38; img[dia2]=col("#e8b53a"); dia3=(u+v)<0.18; img[dia3]=col("#9a2e2e")
    for k in range(1,12):
        pos=(k/12.0)*0.8; m=((np.abs((u+v)-pos)<0.012)&((u+v)>0.55)&(np.maximum(u,v)<0.82)); img[m]=col("#e8d9a8")
    img*=(1+0.05*noise(S,S,1.0,32)[...,None]); save(img,"rug",flip=False)
def shutters():
    cols=["#2f6f73","#2d4a6b","#3f6a4a","#7b3a2f","#b8323c","#c9a227","#5a3a22","#e8e0cc"]; img=np.zeros((256,512,3))
    for i,c in enumerate(cols):
        cell=np.zeros((256,64,3)); cell[:]=col(c)
        for y in range(10,250,14): cell[y:y+4]*=0.55; cell[y+4:y+7]*=1.12
        cell[:,:5]*=0.6; cell[:,-5:]*=0.6; cell[:5]*=0.6; cell[-5:]*=0.6
        img[:,i*64:(i+1)*64]=cell
    save(img,"shutters",flip=False)
FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
SIGNS=[("SAGE'S LIBRARY","#2a3b5a","#f0d98a"),("FIXER'S FORGE","#4a2a22","#f2a33a"),("KRONIKLER PRESS","#1f3f33","#f1e6c8"),("MATCHMAKER'S TEA HOUSE","#6a2740","#f6d9a8"),
       ("PROVOKATOV HALL","#5a1f1f","#f4c96a"),("KOVA'S SPICES","#7a4a12","#fff0c8"),("REKINDER LAMPS","#22304a","#ffd36b"),("THE GOLDEN SCALE","#3a3a22","#e8c44a"),
       ("BAKERY","#7a3a22","#fbe9c4"),("APOTHECARY","#1f4a3f","#e8f1d8"),("INK & QUILL","#2b2b4a","#e6e0ff"),("CLOTH & DYE","#4a2a5a","#ffd8f0"),
       ("COFFEE","#3a2a22","#f2d9b0"),("FRUIT & FIG","#2f5a2a","#ffe9a8"),("TODAY'S TEA","#2a2a2a","#f2f0e8"),("SALT ROAD TRADING","#1f4a6a","#f4efe0")]
def signs():
    img=_I.new("RGB",(1024,1024)); d=ImageDraw.Draw(img)
    for k,(txt,bg,fg) in enumerate(SIGNS):
        cx,cy=(k%2)*512,(k//2)*128
        d.rectangle([cx,cy,cx+511,cy+127],fill=bg); d.rectangle([cx+6,cy+6,cx+505,cy+121],outline=fg,width=3); d.rectangle([cx+13,cy+13,cx+498,cy+114],outline=fg,width=1)
        size=62
        while True:
            f=ImageFont.truetype(FONT,size); b=d.textbbox((0,0),txt,font=f)
            if b[2]-b[0]<=440 or size<18: break
            size-=2
        d.text((cx+256-(b[2]-b[0])/2-b[0],cy+64-(b[3]-b[1])/2-b[1]),txt,font=f,fill=fg)
    img.save(f"{OUT}/signs.jpg",quality=90)
def blades():
    img=_I.new("RGB",(512,512)); d=ImageDraw.Draw(img); bgs=["#2a3b5a","#4a2a22","#1f3f33","#6a2740"]
    for k in range(16):
        cx,cy=(k%4)*128,(k//4)*128; bg=bgs[(k+k//4)%4]; d.rectangle([cx,cy,cx+127,cy+127],fill="#e8dcc0"); d.rectangle([cx+4,cy+4,cx+123,cy+123],outline=bg,width=5)
        m=k%8; c=bg; mid=(cx+64,cy+64)
        if m==0: d.ellipse([cx+36,cy+44,cx+88,cy+96],fill=c); d.rectangle([cx+84,cy+56,cx+98,cy+76],outline=c,width=5); d.rectangle([cx+34,cy+98,cx+90,cy+104],fill=c)   # cup
        elif m==1: d.ellipse([cx+36,cy+30,cx+66,cy+60],outline=c,width=7); d.rectangle([cx+62,cy+42,cx+98,cy+50],fill=c); d.rectangle([cx+86,cy+50,cx+92,cy+66],fill=c)  # key
        elif m==2: d.rectangle([cx+34,cy+34,cx+94,cy+94],fill=c); d.rectangle([cx+42,cy+44,cx+86,cy+50],fill="#e8dcc0"); d.rectangle([cx+42,cy+58,cx+86,cy+64],fill="#e8dcc0"); d.rectangle([cx+42,cy+72,cx+74,cy+78],fill="#e8dcc0")  # scroll
        elif m==3: d.ellipse([cx+30,cy+46,cx+98,cy+90],fill=c); [d.line([cx+44+i*14,cy+50,cx+36+i*14,cy+86],fill="#e8dcc0",width=3) for i in range(4)]  # bread
        elif m==4: d.ellipse([cx+40,cy+56,cx+88,cy+102],fill=c); d.rectangle([cx+56,cy+30,cx+72,cy+62],fill=c)  # potion
        elif m==5: d.polygon([(cx+30,cy+78),(cx+98,cy+78),(cx+86,cy+96),(cx+42,cy+96)],fill=c); d.rectangle([cx+50,cy+44,cx+78,cy+78],fill=c)  # anvil
        elif m==6: d.rectangle([cx+34,cy+34,cx+64,cy+94],fill=c); d.rectangle([cx+68,cy+34,cx+98,cy+94],fill="#6b4a30")  # book
        else: d.polygon([(cx+64,cy+30),(cx+92,cy+60),(cx+64,cy+98),(cx+36,cy+60)],fill=c)  # lantern/gem
    img.save(f"{OUT}/blades.jpg",quality=90)
def newsprint():
    img=_I.new("RGB",(256,352),"#ece6d6"); d=ImageDraw.Draw(img); f=ImageFont.truetype(FONT,30); f2=ImageFont.truetype(FONT,13)
    d.text((12,8),"THE KRONIKLE",font=f,fill="#1d1d1d"); d.line([(10,46),(246,46)],fill="#1d1d1d",width=3)
    d.text((12,52),"VERSE DIGEST  ·  TODAY'S THREADS",font=f2,fill="#333333")
    d.rectangle([12,74,124,150],fill="#9a9488")
    for col,x0 in enumerate((12,132)):
        for k in range(22):
            y=(158 if col==0 else 74)+k*9
            if y>340: break
            w=104 if (k%6)!=5 else 60; d.line([(x0,y),(x0+w,y)],fill="#555555",width=2)
    img.save(f"{OUT}/newsprint.jpg",quality=88)
PALN=[("trunk_dark","#3b2a20"),("trunk","#6b4a30"),("leaf_dark","#2e6b3a"),("leaf","#4f9a4c"),("gold","#c9a227"),("stone_lt","#d8cdb8"),("stone","#8d8173"),("cream","#e8e0cc"),
 ("water_deep","#2f6f8f"),("water","#58a7bf"),("iron","#2a2a30"),("lamp","#f7d98a"),("crimson","#a3392e"),("white","#e8e8e0"),("grey","#7a7a82"),("wood","#b87a4b"),
 ("magenta","#c2377a"),("orange","#e07a2a"),("brick","#8a3f2e"),("copper","#b5693a"),("brass","#c9a24a"),("door_blue","#2d4a8c"),("door_green","#2f6b4a"),("door_red","#8a2a2a"),
 ("teal","#1f8a8a"),("yellow","#f0c52a"),("purple","#6a3a8a"),("pink","#e88aa8"),("terracotta","#b8613a"),("paper","#efe6cf"),("wood_dark","#4a2e1a"),("fire","#ff8a2a"),
 ("pot_green","#3a6a3a"),("sky_blue","#6aa8d8"),("lime","#9acd3a"),("cloth_red","#c0392b"),("cloth_blue","#2b6cb0"),("cloth_gold","#e0a82e"),("cloth_green","#2f855a"),("bread","#d9a566"),("ink","#1a2030")]
def palette():
    img=np.zeros((64,64,3)); img[:]=col("#808080")
    for i,(n,c) in enumerate(PALN):
        r,cc=divmod(i,8); img[r*8:(r+1)*8,cc*8:(cc+1)*8]=col(c)
    save(img,"palette",flip=False,q=95); json.dump({n:i for i,(n,c) in enumerate(PALN)},open("palette.json","w"))
def tile_roof():
    S=512; img=np.zeros((S,S,3)); n=noise(S,S,1.2)
    rows=16; rh=S//rows
    for r in range(rows):
        base=col("#b8553a")*(0.85+0.2*rng.random())
        img[r*rh:(r+1)*rh]=base
        img[r*rh:r*rh+3]*=0.65               # shadow line under each tile course
        for c in range(0,S,32): img[r*rh:(r+1)*rh,c:c+2]*=0.8
    img*=(1+0.07*n[...,None]); save(img,"roof_tile")
def flat_roof():
    S=256; n=noise(S,S,1.0); save(shade(col("#8b8479"),n,0.12),"roof_flat")
def cobble():
    S=512; img=np.zeros((S,S,3)); img[:]=col("#6e604f"); n=noise(S,S,1.0)
    rowsN=16; rh=S//rowsN
    for r in range(rowsN):
        off=(r%2)*16; x=off-16
        while x<S:
            w=int(rng.integers(26,38)); c=col("#b7a68a")*(0.82+0.3*rng.random())*np.array([1,0.98,0.95])
            x0,x1,y0,y1=max(x+2,0),min(x+w-2,S),r*rh+2,(r+1)*rh-2
            if x1>x0: img[y0:y1,x0:x1]=c
            x+=w
    img*=(1+0.05*n[...,None]); save(img,"cobble")
def sidewalk():
    S=512; n=noise(S,S,1.2); img=shade(col("#cfc6b4"),n,0.06).copy()
    for k in range(0,S,128): img[k:k+3]*=0.8; img[:,k:k+3]*=0.8
    save(img,"sidewalk")
def road_plain():
    S=256; n=noise(S,S,1.3); save(shade(col("#4b4b52"),n,0.10),"road_plain")
def road_lines(name,avenue):
    S=512; n=noise(S,S,1.3); img=shade(col("#4b4b52"),n,0.10).copy()   # u along (8 m), v across
    def hline(v,h,c,dash=None):
        y0=int(v*S)-h//2
        if dash is None: img[y0:y0+h]=col(c)
        else:
            for x in range(0,S,dash*2): img[y0:y0+h,x:x+dash]=col(c)
    if avenue:
        hline(0.49,5,"#e2b72a"); hline(0.515,5,"#e2b72a"); hline(0.25,5,"#e8e8e0",S//4); hline(0.75,5,"#e8e8e0",S//4)
    else: hline(0.5,6,"#e8e8e0",S//4)
    hline(0.035,4,"#cfcfc8"); hline(0.965,4,"#cfcfc8"); save(img,name)
def grass():
    S=512; n=noise(S,S,1.2); n2=noise(S,S,0.6); img=shade(col("#6f9a4e"),n,0.12)*(1+0.05*n2[...,None]); save(img,"grass")
def courtyard():
    S=256; n=noise(S,S,1.3); save(shade(col("#a89574"),n,0.10),"courtyard")
def awning():
    S=256; img=np.zeros((S,S,3)); pairs=[("#1f8a8a","#f2ead2"),("#f0a82a","#f2ead2"),("#b8323c","#f2ead2"),("#274a8c","#f2ead2")]
    rh=S//4
    for r,(a,b) in enumerate(pairs):
        for x in range(0,S,32): img[r*rh:(r+1)*rh,x:x+16]=col(a); img[r*rh:(r+1)*rh,x+16:x+32]=col(b)
    img*=(1+0.03*noise(S,S,1.0)[...,None]); save(img,"awning")
tile_roof(); flat_roof(); cobble(); sidewalk(); road_plain(); road_lines("road_narrow",False); road_lines("road_avenue",True)
grass(); courtyard(); awning(); interior_wall(); wood_floor(); rug(); shutters(); signs(); blades(); newsprint(); palette()
print(sorted(os.listdir(OUT)), sum(os.path.getsize(f"{OUT}/{f}") for f in os.listdir(OUT))//1024,"KB")
