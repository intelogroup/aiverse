"""Hero building: 'Matchmaker's Tea House' — real openings, glazing, a furnished ground-floor interior."""
import math, random
from kit import *
from details import *
import doors
GLASS="glass"
def hero_ground(bd,fr,W,D,GH,rnd,plain_sub,sign=3,blade_k=0,door_col="door_green",interior_fn=None,door_style=0,door_no=1):
    v0,v1=plain_sub; T=0.3; f=0.28
    bays=max(1,round(W/4.0)); bw=W/bays; db=bays//2
    def outer(s0,s1,z0,z1,bs0):
        u0=(s0-bs0)/bw; u1=(s1-bs0)/bw; a=v0+z0/GH*(v1-v0); b=v0+z1/GH*(v1-v0)
        pts=[fr.p(s0,0,z0),fr.p(s1,0,z0),fr.p(s1,0,z1),fr.p(s0,0,z1)]
        uv2=[((p[0]*fr.r[0]+p[1]*fr.r[1])/3.5,p[2]/3.5) for p in pts]   # wall-planar plaster channel, same convention as build_city.wallq
        tq("facade_"+bd["mat"],pts,[(u0,a),(u1,a),(u1,b),(u0,b)],fr.o(0,1),uv2=uv2)
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
            doors.entrance(fr,c,door_style,door_col,door_no)                                            # closed leaf + frame detail (doors never open); static part is instanced
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
    interior_fn(bd,fr,W,D,GH,rnd,f,db,bw)
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

def hero_ceiling(fr,W,D,GH):
    T=0.3
    pquad("palette",fr.p(T,-T,GH),fr.p(W-T,-T,GH),fr.p(W-T,-D+T,GH),fr.p(T,-D+T,GH),"paper",(0,0,-1))
    # no ceiling beams: from above they would sit under the cutaway as a pergola

import kit as _k
for _n in ["hero_ground","table","chair","hero_ceiling"]: globals()[_n]=_k.prof("hero."+_n,globals()[_n])
