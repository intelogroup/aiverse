"""Hero building: 'Matchmaker's Tea House' — real openings, glazing, a furnished ground-floor interior."""
import math, random
from kit import *
from details import *
GLASS="glass"
def hero_ground(bd,fr,W,D,GH,rnd,plain_sub,sign=3,blade_k=0,door_col="door_green",interior_fn=None):
    v0,v1=plain_sub; T=0.3; f=0.28
    bays=max(1,round(W/4.0)); bw=W/bays; db=bays//2
    def outer(s0,s1,z0,z1,bs0):
        u0=(s0-bs0)/bw; u1=(s1-bs0)/bw; a=v0+z0/GH*(v1-v0); b=v0+z1/GH*(v1-v0)
        tq("facade_"+bd["mat"],[fr.p(s0,0,z0),fr.p(s1,0,z0),fr.p(s1,0,z1),fr.p(s0,0,z1)],[(u0,a),(u1,a),(u1,b),(u0,b)],fr.o(0,1))
        tq("interior_wall",[fr.p(s0,-T,z0),fr.p(s1,-T,z0),fr.p(s1,-T,z1),fr.p(s0,-T,z1)],[(s0/4,z0/GH),(s1/4,z0/GH),(s1/4,z1/GH),(s0/4,z1/GH)],fr.o(0,-1))
    doorpos=None
    for k in range(bays):
        s0=k*bw; s1=s0+bw; c=(s0+s1)/2
        if k==db: ow,zb,zt=1.7,0.0,2.9
        else: ow,zb,zt=min(2.9,bw-0.9),0.85,3.1
        ou0,ou1=c-ow/2,c+ow/2
        outer(s0,ou0,0,GH,s0); outer(ou1,s1,0,GH,s0)
        if zb>0: outer(ou0,ou1,0,zb,s0)
        outer(ou0,ou1,zt,GH,s0)
        for (ua,ub,za,zb_,o) in ((ou0,ou0,zb,zt,fr.o(1,0)),(ou1,ou1,zb,zt,fr.o(-1,0))):    # jambs
            pquad("palette",fr.p(ua,0,za),fr.p(ua,-T,za),fr.p(ua,-T,zb_),fr.p(ua,0,zb_),"stone_lt",o)
        pquad("palette",fr.p(ou0,0,zt),fr.p(ou1,0,zt),fr.p(ou1,-T,zt),fr.p(ou0,-T,zt),"stone_lt",(0,0,-1))
        if zb>0:
            pquad("palette",fr.p(ou0,0,zb),fr.p(ou1,0,zb),fr.p(ou1,-T,zb),fr.p(ou0,-T,zb),"stone_lt",(0,0,1))
            fbox(fr,ou0-0.15,ou1+0.15,0,0.22,zb-0.13,zb,"stone_lt")                                  # outer sill
            tq(GLASS,[fr.p(ou0,-0.12,zb),fr.p(ou1,-0.12,zb),fr.p(ou1,-0.12,zt),fr.p(ou0,-0.12,zt)],[(0,0)]*4,fr.o(0,1))
            for u in (ou0,c,ou1): fbox(fr,u-0.025,u+0.025,-0.14,-0.08,zb,zt,"wood_dark",top=False)
            for z in (zb,(zb+zt)/2,zt-0.04): fbox(fr,ou0,ou1,-0.14,-0.08,z,z+0.04,"wood_dark",top=False)
            if rnd.random()<0.9: awning_bay(fr,s0+0.3,s1-0.3,0,rnd.randrange(4))
            for k2 in range(5): fbox(fr,c-1.1+k2*0.5,c-0.95+k2*0.5,0.05,0.25,zb,zb+0.12,rnd.choice(FLOWERS))
        else:
            doorpos=c
            fbox(fr,ou0,ou1,-T,0.0,0,f,"stone"); fbox(fr,c-1.3,c+1.3,0,0.85,0,f,"stone")
            fbox(fr,c-1.0,c-0.8,0,0.14,f,zt+0.25,"stone_lt"); fbox(fr,c+0.8,c+1.0,0,0.14,f,zt+0.25,"stone_lt"); fbox(fr,c-1.0,c+1.0,0,0.16,zt,zt+0.26,"stone_lt")
            th=1.25; hu=ou0+0.04; tu=hu+1.5*math.cos(th); tt=-0.1-1.5*math.sin(th)                    # leaf swung open into the room
            col=door_col
            two_sided("palette",[fr.p(hu,-0.1,f),fr.p(tu,tt,f),fr.p(tu,tt,zt-0.05),fr.p(hu,-0.1,zt-0.05)],[pal_uv(col)]*4,fr.o(-(tt+0.1),tu-hu))
            lantern_wall(fr,c+1.35,2.5); lantern_wall(fr,c-1.35,2.5)
    cu=db*bw+bw/2
    fascia(fr,cu-2.0,cu+2.0,3.3,4.3,sign)                                                                  # 4:1, matches the sign cell
    blade(fr,cu+2.4,3.0,blade_k)
    # ---- inner shell: side + back walls, floor, cap ring ----
    for (u,t0,t1,o) in ((T,-T,-D+T,fr.o(1,0)),(W-T,-T,-D+T,fr.o(-1,0))):
        tq("interior_wall",[fr.p(u,t0,0),fr.p(u,t1,0),fr.p(u,t1,GH),fr.p(u,t0,GH)],[((abs(t0))/4,0),(abs(t1)/4,0),(abs(t1)/4,1),(abs(t0)/4,1)],o)
    tq("interior_wall",[fr.p(T,-D+T,0),fr.p(W-T,-D+T,0),fr.p(W-T,-D+T,GH),fr.p(T,-D+T,GH)],[(T/4,0),((W-T)/4,0),((W-T)/4,1),(T/4,1)],fr.o(0,1))
    tq("wood_floor",[fr.p(T,-T,f),fr.p(W-T,-T,f),fr.p(W-T,-D+T,f),fr.p(T,-D+T,f)],[(0,0),((W-2*T)/2.56,0),((W-2*T)/2.56,(D-2*T)/2.56),(0,(D-2*T)/2.56)],(0,0,1))
    for (a,b,c_,d_) in ((0,W,-T,0),(0,W,-D,-D+T),(0,T,-D,0),(W-T,W,-D,0)): pquad("palette",fr.p(a,c_,GH),fr.p(b,c_,GH),fr.p(b,d_,GH),fr.p(a,d_,GH),"stone_lt",(0,0,1))
    (interior_fn or interior)(bd,fr,W,D,GH,rnd,f,db,bw)
    return doorpos
def table(fr,u,d,f,rnd,Zb,skip=()):
    x,y=fr.xy(u,-d); cyl(x,y,Zb+f,Zb+f+0.72,0.05,6,"iron",top=False); cyl(x,y,Zb+f+0.72,Zb+f+0.78,0.46,10,"wood")
    cyl(x,y,Zb+f,Zb+f+0.04,0.25,8,"iron")
    pbox(x-0.1,y-0.07,x+0.1,y+0.07,Zb+f+0.78,Zb+f+0.86,rnd.choice(["crimson","teal","yellow","cream"]))
    for (du,dd,back) in ((0.78,0,"+u"),(-0.78,0,"-u"),(0,0.78,"+d"),(0,-0.78,"-d")):
        if back in skip or rnd.random()<0.5: continue
        chair(fr,u+du,d+dd,f,back)
def chair(fr,u,d,f,back):
    face={"+u":(-1,0),"-u":(1,0),"+d":(0,1),"-d":(0,-1)}[back]
    add_anchor(fr,u,-d,face[0],face[1],0.49,"chair",f,side=-1)
    fbox(fr,u-0.2,u+0.2,-d-0.2,-d+0.2,f+0.44,f+0.49,"wood")
    for (a,b) in ((-0.18,-0.18),(0.18,-0.18),(0.18,0.18),(-0.18,0.18)): fbox(fr,u+a-0.02,u+a+0.02,-d+b-0.02,-d+b+0.02,f,f+0.44,"wood_dark",top=False)
    if back=="+u": fbox(fr,u+0.17,u+0.2,-d-0.2,-d+0.2,f+0.49,f+0.95,"wood")
    if back=="-u": fbox(fr,u-0.2,u-0.17,-d-0.2,-d+0.2,f+0.49,f+0.95,"wood")
    if back=="+d": fbox(fr,u-0.2,u+0.2,-d-0.2,-d-0.17,f+0.49,f+0.95,"wood")
    if back=="-d": fbox(fr,u-0.2,u+0.2,-d+0.17,-d+0.2,f+0.49,f+0.95,"wood")
def interior(bd,fr,W,D,GH,rnd,f,db,bw):
    Zb=fr.z0; T=0.3
    # rug
    cu=W/2; rug=[fr.p(cu-3.2,-3.2,f+0.04),fr.p(cu+3.2,-3.2,f+0.04),fr.p(cu+3.2,-7.2,f+0.04),fr.p(cu-3.2,-7.2,f+0.04)]
    tq("rug",rug,[(0,0),(1,0),(1,1),(0,1)],(0,0,1))
    # bar along the back wall + back shelves
    bu0,bu1=2.2,W*0.56; bd0,bd1=D-3.6,D-2.7
    fbox(fr,bu0,bu1,-bd1,-bd0,f,f+1.05,"wood_dark"); fbox(fr,bu0-0.1,bu1+0.1,-bd1-0.12,-bd0+0.12,f+1.05,f+1.12,"wood")
    for u in [bu0+0.7+k*1.1 for k in range(int((bu1-bu0-1.2)/1.1)+1)]:
        x,y=fr.xy(u,-bd0+0.55); cyl(x,y,Zb+f,Zb+f+0.62,0.04,6,"iron",top=False); cyl(x,y,Zb+f+0.62,Zb+f+0.68,0.21,8,"wood_dark")           # stools
        add_anchor(fr,u,-bd0+0.55,0,-1,0.68,"stool",f,side=-1)
    fbox(fr,1.0,W-1.0,-D+T+0.02,-D+T+0.14,f,f+3.1,"wood_dark")
    for zs in (f+1.1,f+1.8,f+2.5):
        fbox(fr,1.0,W-1.0,-D+T+0.14,-D+T+0.75,zs,zs+0.05,"wood")
        u=1.2
        while u<W-1.3:
            hh=rnd.uniform(0.22,0.4); c=rnd.choice(["crimson","teal","yellow","orange","magenta","cloth_blue","lime","copper","paper"])
            fbox(fr,u,u+0.12,-D+T+0.3,-D+T+0.42,zs+0.05,zs+0.05+hh,c); u+=rnd.uniform(0.2,0.45)
    for k in range(3):                                                                                      # kettles + machine on the bar
        x,y=fr.xy(bu0+1.0+k*1.2,-(bd0+bd1)/2); cyl(x,y,Zb+f+1.12,Zb+f+1.5,0.2,8,"copper",r1=0.15); cyl(x,y,Zb+f+1.5,Zb+f+1.56,0.08,6,"brass")
    fbox(fr,bu1-1.4,bu1-0.4,-(bd0+bd1)/2-0.3,-(bd0+bd1)/2+0.3,f+1.12,f+1.6,"brass"); fbox(fr,bu1-1.3,bu1-0.5,-(bd0+bd1)/2-0.25,-(bd0+bd1)/2+0.25,f+1.6,f+1.7,"copper")
    # tables + chairs (two rows) leaving the door lane free
    # two staggered rows, 3.6 m pitch: chairs are entered from behind, so neighbouring
    # stand points stay >= 0.8 m apart; the back row has no bar-side chairs (stools own that aisle)
    for dd,u0,skip in ((3.4,2.3,()),(5.8,4.1,("+d",))):
        u=u0
        while u<W-2.0:
            if (abs(u-(db*bw+bw/2))>1.1 or dd>4) and (dd<4 or u<bu1-1.0): table(fr,u,dd,f,rnd,Zb,skip)
            u+=3.6
    lounge(fr,W,D,f,rnd,Zb)
    # window booths along the front wall
    for k in range(max(1,round(W/4.0))):
        if k==db: continue
        c=k*bw+bw/2
        fbox(fr,c-1.2,c+1.2,-1.35,-T-0.02,f,f+0.46,"cloth_red"); fbox(fr,c-1.2,c+1.2,-T-0.1,-T-0.02,f+0.46,f+0.95,"cloth_red")
        for su in (c-0.6,c+0.6): add_anchor(fr,su,-0.85,0,-1,0.46,"booth",f)
    # fireplace on the east wall
    cd=D/2; fbox(fr,W-1.6,W-T,-(cd+1.3),-(cd-1.3),f,f+1.4,"stone"); fbox(fr,W-1.7,W-T,-(cd+1.4),-(cd-1.4),f+1.4,f+1.5,"wood_dark")
    fbox(fr,W-1.6+0.02,W-T,-(cd+0.8),-(cd-0.8),f+0.05,f+0.9,"ink"); fbox(fr,W-1.45,W-T-0.1,-(cd+0.55),-(cd-0.55),f+0.05,f+0.5,"fire",b="lamp_glow")
    fbox(fr,W-1.3,W-T,-(cd+0.8),-(cd-0.8),f+1.5,GH,"stone")
    # west wall: menu board, frames, shelf with books
    pts=[fr.p(T+0.02,-(5.0),f+2.0),fr.p(T+0.02,-(3.2),f+2.0),fr.p(T+0.02,-(3.2),f+2.5),fr.p(T+0.02,-(5.0),f+2.5)]
    tq("signs",pts,sign_cell(14),fr.o(1,0))
    for k,(dd,c) in enumerate(((6.4,"crimson"),(7.2,"teal"),(8.0,"yellow"))): fbox(fr,T,T+0.05,-(dd+0.3),-(dd-0.3),f+1.8,f+2.4,"wood_dark"); fbox(fr,T+0.05,T+0.07,-(dd+0.24),-(dd-0.24),f+1.86,f+2.34,c)
    fbox(fr,T,T+0.4,-(D-3.0),-(D-5.4),f+1.3,f+1.36,"wood")
    for k in range(9): fbox(fr,T+0.05,T+0.3,-(D-3.1-k*0.24),-(D-3.1-k*0.24-0.2),f+1.36,f+1.36+rnd.uniform(0.2,0.35),rnd.choice(["door_blue","door_red","door_green","wood_dark","gold","paper"]))
    # plants
    for (u,dd) in ((0.9,0.9),(W-0.9,0.9),(0.9,D-1.0)):
        x,y=fr.xy(u,-dd); cyl(x,y,Zb+f,Zb+f+0.45,0.28,8,"terracotta",r1=0.22)
        for k in range(6):
            a=math.pi/3*k; ptri("palette",(x,y,Zb+f+0.45),(x+0.5*math.cos(a),y+0.5*math.sin(a),Zb+f+1.2+0.1*(k%2)),(x+0.5*math.cos(a+0.7),y+0.5*math.sin(a+0.7),Zb+f+0.7),"leaf" if k%2 else "leaf_dark",(0,0,1))
            ptri("palette",(x,y,Zb+f+0.45),(x+0.5*math.cos(a+0.7),y+0.5*math.sin(a+0.7),Zb+f+0.7),(x+0.5*math.cos(a),y+0.5*math.sin(a),Zb+f+1.2+0.1*(k%2)),"leaf",(0,0,-1))
    # hanging lanterns
    for (u,dd) in ((W*0.25,2.5),(W*0.5,2.5),(W*0.75,2.5),(W*0.25,6.2),(W*0.5,6.2),(W*0.75,6.2)):
        x,y=fr.xy(u,-dd); cyl(x,y,Zb+GH-0.8,Zb+GH,0.012,4,"iron",top=False); pbox(x-0.17,y-0.17,x+0.17,y+0.17,Zb+GH-1.15,Zb+GH-0.8,"lamp",b="lamp_glow"); pbox(x-0.2,y-0.2,x+0.2,y+0.2,Zb+GH-0.82,Zb+GH-0.75,"iron")
def armchair(fr,u,d,f,face,col):
    """Armchair facing +u/-u/+d/-d (d grows into the room)."""
    fbox(fr,u-0.42,u+0.42,-(d+0.42),-(d-0.42),f+0.18,f+0.46,col)                       # seat
    if face in ("+u","-u"):
        s=1 if face=="+u" else -1; b0,b1=(u-0.42,u-0.28) if s>0 else (u+0.28,u+0.42)
        fbox(fr,b0,b1,-(d+0.42),-(d-0.42),f+0.46,f+1.0,col)
        fbox(fr,u-0.42,u+0.42,-(d+0.42),-(d+0.3),f+0.46,f+0.68,col); fbox(fr,u-0.42,u+0.42,-(d-0.3),-(d-0.42),f+0.46,f+0.68,col)
        add_anchor(fr,u,-d,s,0,0.46,"armchair",f)
    else:
        s=1 if face=="+d" else -1; t0,t1=(-(d-0.28),-(d-0.42)) if s>0 else (-(d+0.42),-(d+0.28))
        fbox(fr,u-0.42,u+0.42,t0,t1,f+0.46,f+1.0,col)
        fbox(fr,u-0.42,u-0.3,-(d+0.42),-(d-0.42),f+0.46,f+0.68,col); fbox(fr,u+0.3,u+0.42,-(d+0.42),-(d-0.42),f+0.46,f+0.68,col)
        add_anchor(fr,u,-d,0,-s,0.46,"armchair",f)

def lounge(fr,W,D,f,rnd,Zb):
    cu=W*0.8; cd=D/2
    tq("rug",[fr.p(cu-3.0,-cd+2.2,f+0.04),fr.p(cu+2.2,-cd+2.2,f+0.04),fr.p(cu+2.2,-cd-2.2,f+0.04),fr.p(cu-3.0,-cd-2.2,f+0.04)],[(0,0),(1,0),(1,1),(0,1)],(0,0,1))
    armchair(fr,cu-0.4,cd+1.6,f,"-d","cloth_blue"); armchair(fr,cu-0.4,cd-1.6,f,"+d","cloth_red")
    x,y=fr.xy(cu-0.4,-cd); cyl(x,y,Zb+f,Zb+f+0.4,0.4,10,"wood"); cyl(x,y,Zb+f+0.4,Zb+f+0.45,0.46,10,"wood_dark")
    pbox(x-0.12,y-0.1,x+0.12,y+0.1,Zb+f+0.45,Zb+f+0.55,"copper")
    fbox(fr,cu-2.7,cu-2.0,-(cd+2.0),-(cd-2.0),f,f+0.5,"cloth_gold"); fbox(fr,cu-2.7,cu-2.55,-(cd+2.0),-(cd-2.0),f+0.5,f+1.0,"cloth_gold")      # sofa facing the fire
    for sd in (-1.0,0.0,1.0): add_anchor(fr,cu-2.3,-(cd+sd),1,0,0.5,"sofa",f)
    x,y=fr.xy(W-1.0,-(D-1.2)); cyl(x,y,Zb+f,Zb+f+1.6,0.03,6,"iron",top=False); cyl(x,y,Zb+f+1.6,Zb+f+1.95,0.2,8,"lamp",b="lamp_glow",r1=0.12)             # floor lamp
def hero_ceiling(fr,W,D,GH):
    T=0.3
    pquad("palette",fr.p(T,-T,GH),fr.p(W-T,-T,GH),fr.p(W-T,-D+T,GH),fr.p(T,-D+T,GH),"paper",(0,0,-1))
    u=T+0.6
    while u<W-T:
        fbox(fr,u,u+0.28,-D+T,-T,GH-0.38,GH,"wood_dark",top=False,bottom=True); u+=2.0
    for dd in (D/2,):
        fbox(fr,T,W-T,-dd-0.15,-dd+0.15,GH-0.45,GH,"wood_dark",top=False,bottom=True)

import kit as _k
for _n in ["hero_ground","table","chair","interior","hero_ceiling","lounge"]: globals()[_n]=_k.prof("hero."+_n,globals()[_n])
