import json
from PIL import Image, ImageDraw, ImageFont
P=json.load(open("plan.json")); S=6.0; M=60
L=P["land"]; W=int(2*L*S)+2*M
im=Image.new("RGB",(W,W),(40,90,110)); d=ImageDraw.Draw(im)
def px(x,y): return (M+(x+L)*S, M+(L-y)*S)
def rect(r,fill,outline=None,w=1):
    x0,y0,x1,y1=r; a=px(x0,y1); b=px(x1,y0); d.rectangle([a,b],fill=fill,outline=outline,width=w)
rect([-L,-L,L,L],(205,190,160))                                   # land
for s in P["streets"]:                                            # streets (both axes)
    c,w=s["c"],s["w"]; col=(70,70,78)
    rect([c-w/2,-L,c+w/2,L],col); rect([-L,c-w/2,L,c+w/2],col)
for b in P["blocks"]:                                             # sidewalk pads
    rect(b["rect"],(198,186,168),(150,140,120))
rect(P["plaza"],(176,150,118),(120,95,70),2)                      # cobbled plaza
for p in P["parks"]: rect(p["rect"],(110,160,92))
for c in P["courtyards"]: rect(c["rect"],(172,150,120))
MAT={"sand":(224,196,150),"ochre":(214,164,84),"white":(236,230,216),"rose":(206,128,98),"blue":(132,168,186)}
for b in P["buildings"]:
    rect(b["rect"],MAT[b["mat"]],(90,60,40)); 
    if b["roof"]=="pitched":
        x0,y0,x1,y1=b["rect"]
        a=px((x0+x1)/2,y1-1) ; 
        if (x1-x0)>=(y1-y0): d.line([px(x0+1,(y0+y1)/2),px(x1-1,(y0+y1)/2)],fill=(150,70,40),width=2)
        else: d.line([px((x0+x1)/2,y0+1),px((x0+x1)/2,y1-1)],fill=(150,70,40),width=2)
for h in P["halls"]: rect(h["rect"],(196,120,84),(80,40,30),3)
for t in P["towers"]: rect(t["rect"],(230,215,170) if t["kind"]=="clock" else (240,240,230),(60,40,30),2)
f=P["fountain"]; 
for r,col in ((f["r_out"],(110,170,190)),(f["r_in"],(176,150,118))):
    a=px(-r,r); b=px(r,-r); d.ellipse([a,b],fill=col,outline=(70,110,130))
for s in P["stalls"]:
    x,y=s["c"]; w,h=s["size"]; rect([x-w/2,y-h/2,x+w/2,y+h/2],{"teal":(40,150,150),"saffron":(240,170,40),"crimson":(190,50,60),"cream":(240,230,200)}[s["canopy"]],(60,40,30))
for x,y in P["trees"]:
    a=px(x-2.2,y+2.2); b=px(x+2.2,y-2.2); d.ellipse([a,b],fill=(52,120,60))
for x,y in P["lamps"]:
    a=px(x-.6,y+.6); b=px(x+.6,y-.6); d.ellipse([a,b],fill=(255,230,120))
try: fnt=ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",26)
except: fnt=ImageFont.load_default()
for b in P["blocks"]:
    x0,y0,x1,y1=b["rect"]; p=px((x0+x1)/2,(y0+y1)/2)
    if b["kind"] in ("park","hall","citadel"): d.text(p,{"park":"PARK","hall":"GREAT SOUK HALL","citadel":"CITADEL"}[b["kind"]],fill=(20,20,20),font=fnt,anchor="mm")
d.text(px(0,-24),"BAZAAR PLAZA",fill=(30,20,10),font=fnt,anchor="mm")
d.text((M,12),"CITY 3 — SUNSTONE BAZAAR   360x360 m   plan (north up)   grid: blocks 6x6, avenue 20 m, streets 10 m",fill=(255,255,255),font=fnt)
im.save("plan_topdown.png"); im.resize((1200,1200)).save("plan_topdown_small.png"); print(im.size)
