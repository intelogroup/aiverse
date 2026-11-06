"""Facade details + street furniture (window kit, doors, signs, lamps, bunting, props)."""
import math, random
from kit import *
DOORS=["door_blue","door_green","door_red","wood_dark","teal","cloth_red"]
FLOWERS=["magenta","yellow","orange","pink","white","crimson","purple"]
BUNT=["crimson","yellow","teal","orange","magenta","cloth_blue","lime","white"]
def sign_cell(k):
    c,r=k%2,k//2; u0=c*0.5+0.004; u1=u0+0.492; v1=1-r/8.0-0.003; v0=v1-0.125+0.006
    return [(u0,v0),(u1,v0),(u1,v1),(u0,v1)]
def blade_cell(k):
    c,r=k%4,k//4; u0=c/4.0+0.004; u1=u0+0.242; v1=1-r/4.0-0.004; v0=v1-0.242
    return [(u0,v0),(u1,v0),(u1,v1),(u0,v1)]
def shut_cell(i): u0=i/8.0+0.004; u1=(i+1)/8.0-0.004; return [(u0,0),(u1,0),(u1,1),(u0,1)]
def two_sided(b,pts,uvs,out):
    tq(b,pts,uvs,out); tq(b,pts,uvs,(-out[0],-out[1],-out[2]))
def shutter(fr,hinge_u,tip_sign,w,z0,z1,theta,cell,t0=0.04):
    a=(hinge_u,t0); bu=hinge_u+tip_sign*w*math.cos(theta); bt=t0+w*math.sin(theta)
    pts=[fr.p(a[0],a[1],z0),fr.p(bu,bt,z0),fr.p(bu,bt,z1),fr.p(a[0],a[1],z1)]
    du,dt=bu-a[0],bt-a[1]; out=fr.o(-dt,du) if tip_sign>0 else fr.o(dt,-du)
    if abs(out[0])+abs(out[1])<1e-6: out=fr.o(0,1)
    two_sided("shutters",pts,shut_cell(cell),out)
def window(fr,cu,ww,zb,rnd,style,cell,balcony_ok=True,tall=1.0):
    """Proud geometry around one window whose painted opening is centred on u=cu, sill line at z=zb."""
    fbox(fr,cu-ww/2-0.14,cu+ww/2+0.14,0,0.2,zb-0.13,zb,"stone_lt",top=True)
    if style=="A":                                                                       # lintel with a keystone block above the opening + sill corbels
        zt=zb+1.62*tall; fbox(fr,cu-ww/2-0.12,cu+ww/2+0.12,0,0.13,zt,zt+0.14,"stone_lt",top=True)
        fbox(fr,cu-0.1,cu+0.1,0,0.17,zt-0.02,zt+0.24,"stone",top=False)
        for s_ in (-1,1): fbox(fr,cu+s_*(ww/2-0.08)-0.05,cu+s_*(ww/2-0.08)+0.05,0,0.14,zb-0.3,zb-0.13,"stone",top=False)
    if style=="A" and rnd.random()<0.8:
        th=rnd.choice([0,0,0,0.6,1.1]); sw=ww/2+0.02
        shutter(fr,cu-ww/2-0.04,-1,sw,zb-0.02,zb+1.62*tall,th,cell); shutter(fr,cu+ww/2+0.04,1,sw,zb-0.02,zb+1.62*tall,th,cell)
    if style=="A" and rnd.random()<0.45:                                                  # flower box
        fbox(fr,cu-ww/2-0.05,cu+ww/2+0.05,0.04,0.30,zb,zb+0.26,"terracotta",top=False)
        pquad("palette",fr.p(cu-ww/2,0.07,zb+0.26),fr.p(cu+ww/2,0.07,zb+0.26),fr.p(cu+ww/2,0.27,zb+0.26),fr.p(cu-ww/2,0.27,zb+0.26),"leaf_dark",(0,0,1))
        for k in range(4):
            fu=cu-ww/2+0.15+k*(ww-0.3)/3; c=rnd.choice(FLOWERS)
            ptri("palette",fr.p(fu-0.09,0.12,zb+0.26),fr.p(fu+0.09,0.12,zb+0.26),fr.p(fu,0.12,zb+0.5),c,fr.o(0,1)); ptri("palette",fr.p(fu,0.12,zb+0.26),fr.p(fu,0.26,zb+0.26),fr.p(fu,0.2,zb+0.5),c,fr.o(1,0))
    if style=="B" and balcony_ok and rnd.random()<0.4:                                    # french window balcony
        zf=zb-0.15
        fbox(fr,cu-1.0,cu+1.0,0,0.75,zf-0.12,zf+0.04,"stone")
        fbox(fr,cu-1.0,cu+1.0,0.69,0.75,zf+1.0,zf+1.05,"iron",top=False); fbox(fr,cu-1.0,cu-0.94,0.0,0.75,zf+1.0,zf+1.05,"iron",top=False); fbox(fr,cu+0.94,cu+1.0,0.0,0.75,zf+1.0,zf+1.05,"iron",top=False)
        for zr in (zf+0.35,zf+0.68): pquad("palette",fr.p(cu-1.0,0.72,zr),fr.p(cu+1.0,0.72,zr),fr.p(cu+1.0,0.72,zr+0.03),fr.p(cu-1.0,0.72,zr+0.03),"iron",fr.o(0,1))
        for pu in (cu-1.0,cu+0.97): fbox(fr,pu-0.03,pu+0.03,0.66,0.75,zf+0.04,zf+1.0,"iron",top=False)

def lantern_wall(fr,u,z):
    fbox(fr,u-0.1,u+0.1,0.0,0.3,z-0.18,z+0.2,"lamp",b="lamp_glow",top=False); fbox(fr,u-0.13,u+0.13,0.0,0.34,z+0.2,z+0.25,"iron")

def door(fr,cu,rnd,market):
    col=rnd.choice(DOORS)
    fbox(fr,cu-1.3,cu+1.3,0,0.85,0,0.26,"stone")                                           # stoop
    fbox(fr,cu-0.95,cu-0.72,0,0.14,0.26,3.1,"stone_lt",top=False); fbox(fr,cu+0.72,cu+0.95,0,0.14,0.26,3.1,"stone_lt",top=False)
    fbox(fr,cu-0.95,cu+0.95,0,0.16,2.86,3.12,"stone_lt")
    fbox(fr,cu-0.72,cu+0.72,0.0,0.07,0.26,2.86,col,top=False)                              # leaf
    for (pu0,pu1) in ((-0.6,-0.04),(0.04,0.6)): fbox(fr,cu+pu0,cu+pu1,0.07,0.1,0.45,2.65,"wood_dark",top=False,)
    pquad("palette",fr.p(cu-0.6,0.075,2.88),fr.p(cu+0.6,0.075,2.88),fr.p(cu+0.6,0.075,3.1),fr.p(cu-0.6,0.075,3.1),"ink",fr.o(0,1))   # transom
    pquad("palette",fr.p(cu+0.5,0.105,1.25),fr.p(cu+0.58,0.105,1.25),fr.p(cu+0.58,0.105,1.33),fr.p(cu+0.5,0.105,1.33),"brass",fr.o(0,1))
    pquad("palette",fr.p(cu-0.85,0.045,2.3),fr.p(cu-0.65,0.045,2.3),fr.p(cu-0.65,0.045,2.45),fr.p(cu-0.85,0.045,2.45),"paper",fr.o(0,1))
    lantern_wall(fr,cu+1.3,2.45)

def fascia(fr,s0,s1,z0,z1,k):
    fbox(fr,s0-0.06,s1+0.06,0,0.1,z0-0.06,z1+0.06,"wood_dark")
    pts=[fr.p(s0,0.14,z0),fr.p(s1,0.14,z0),fr.p(s1,0.14,z1),fr.p(s0,0.14,z1)]
    tq("signs",pts,sign_cell(k),fr.o(0,1))
def blade(fr,u,z,k):
    fbox(fr,u-0.03,u+0.03,0,0.95,z+0.55,z+0.6,"iron",top=False)
    for (t0,t1) in ((0.12,0.12),(0.88,0.88)): pass
    pts=[fr.p(u,0.12,z-0.4),fr.p(u,0.9,z-0.4),fr.p(u,0.9,z+0.4),fr.p(u,0.12,z+0.4)]
    two_sided("blades",pts,blade_cell(k),fr.o(1,0)); fbox(fr,u-0.025,u+0.025,0.1,0.92,z+0.4,z+0.46,"wood_dark")
def awning_bay(fr,s0,s1,z0,row,out=1.8):
    v0=row/4+0.02; v1=(row+1)/4-0.02; wl=s1-s0
    top0=fr.p(s0,0,z0+3.2); top1=fr.p(s1,0,z0+3.2); lo0=fr.p(s0,out,z0+2.6); lo1=fr.p(s1,out,z0+2.6)
    for sgn in (1,-1): mb("awning").quad(top0,top1,lo1,lo0,(0,v1),(wl/2.5,v1),(wl/2.5,v0),(0,v0),(fr.n[0]*0.4*sgn,fr.n[1]*0.4*sgn,0.9*sgn))
def lamp(x,y,Z,hang):
    cyl(x,y,Z,Z+0.5,0.2,6,"iron",top=False,r1=0.1); cyl(x,y,Z+0.5,Z+4.5,0.07,6,"iron",top=False)
    pbox(x-0.3,y-0.3,x+0.3,y+0.3,Z+4.5,Z+4.58,"iron"); pbox(x-0.2,y-0.2,x+0.2,y+0.2,Z+4.58,Z+5.1,"lamp",b="lamp_glow")
    for k in range(4):
        a0=math.pi/2*k+math.pi/4; a1=a0+math.pi/2
        ptri("palette",(x+0.34*math.cos(a0),y+0.34*math.sin(a0),Z+5.1),(x+0.34*math.cos(a1),y+0.34*math.sin(a1),Z+5.1),(x,y,Z+5.5),"iron",(math.cos((a0+a1)/2),math.sin((a0+a1)/2),0.5))
    if hang:
        pbox(x+0.1,y-0.2,x+0.5,y+0.2,Z+3.3,Z+3.55,"terracotta")
        for k in range(3): ptri("palette",(x+0.12+k*0.14,y,Z+3.55),(x+0.26+k*0.14,y,Z+3.55),(x+0.19+k*0.14,y,Z+3.85),FLOWERS[(k+int(abs(x)))%len(FLOWERS)],(0,-1,0)); ptri("palette",(x+0.12+k*0.14,y,Z+3.55),(x+0.26+k*0.14,y,Z+3.55),(x+0.19+k*0.14,y,Z+3.85),FLOWERS[(k+int(abs(x)))%len(FLOWERS)],(0,1,0))

def bench(cx,cy,Z,horiz,color="wood"):
    if horiz: u0,u1,v0,v1=cx-0.8,cx+0.8,cy-0.22,cy+0.22
    else: u0,u1,v0,v1=cx-0.22,cx+0.22,cy-0.8,cy+0.8
    pbox(u0,v0,u1,v1,Z+0.42,Z+0.48,color)
    if horiz: pbox(u0,cy+0.18,u1,cy+0.22,Z+0.48,Z+0.95,color); [pbox(x-0.04,v0,x+0.04,v1,Z,Z+0.42,"iron") for x in (u0+0.1,u1-0.1)]
    else: pbox(cx+0.18,v0,cx+0.22,v1,Z+0.48,Z+0.95,color); [pbox(u0,y-0.04,u1,y+0.04,Z,Z+0.42,"iron") for y in (v0+0.1,v1-0.1)]
def planter(x,y,Z,rnd,big=False):
    w=0.7 if big else 0.45; pbox(x-w,y-w,x+w,y+w,Z,Z+0.55,"stone"); pbox(x-w-0.04,y-w-0.04,x+w+0.04,y+w+0.04,Z+0.5,Z+0.6,"stone_lt")
    pquad("palette",(x-w+0.05,y-w+0.05,Z+0.62),(x+w-0.05,y-w+0.05,Z+0.62),(x+w-0.05,y+w-0.05,Z+0.62),(x-w+0.05,y+w-0.05,Z+0.62),"trunk_dark",(0,0,1))
    for k in range(3):
        a=math.pi*2/3*k+0.4; bx=x+0.3*w*math.cos(a)*2; by=y+0.3*w*math.sin(a)*2
        ptri("palette",(bx-0.22,by-0.22,Z+0.62),(bx+0.22,by+0.22,Z+0.62),(bx,by,Z+1.3),"leaf" if k%2 else "leaf_dark",(0,0,1)); ptri("palette",(bx+0.22,by-0.22,Z+0.62),(bx-0.22,by+0.22,Z+0.62),(bx,by,Z+1.3),"leaf",(0,0,1))
    for k in range(4):
        fx=x-w+0.2+k*(2*w-0.4)/3; fy=y+rnd.uniform(-w+0.2,w-0.2); c=rnd.choice(FLOWERS)
        ptri("palette",(fx-0.1,fy,Z+0.62),(fx+0.1,fy,Z+0.62),(fx,fy,Z+0.95),c,(0,-1,0)); ptri("palette",(fx-0.1,fy,Z+0.62),(fx+0.1,fy,Z+0.62),(fx,fy,Z+0.95),c,(0,1,0))

def barrel(x,y,Z,seg=6):
    cyl(x,y,Z,Z+0.9,0.36,seg,"wood",r1=0.36); cyl(x,y,Z+0.15,Z+0.2,0.375,seg,"iron",top=False); cyl(x,y,Z+0.68,Z+0.73,0.375,seg,"iron",top=False)

def crates(x,y,Z,rnd):
    for (dx,dy,z) in ((0,0,0),(0.62,0.05,0),(0.28,0.0,0.5)): pbox(x+dx-0.3,y+dy-0.3,x+dx+0.3,y+dy+0.3,Z+z,Z+z+0.5,"wood")
    for k in range(4): pbox(x-0.25+k*0.2,y-0.2,x-0.1+k*0.2,y-0.05,Z+1.0,Z+1.14,rnd.choice(["crimson","orange","yellow","lime","magenta"]))
def bin_(x,y,Z): cyl(x,y,Z,Z+0.85,0.3,8,"pot_green",r1=0.3); cyl(x,y,Z+0.85,Z+0.92,0.33,8,"iron")
def umbrella_set(x,y,Z,rnd):
    col=rnd.choice(["cloth_red","cloth_blue","cloth_gold","cloth_green"])
    cyl(x,y,Z,Z+0.74,0.05,6,"iron",top=False); cyl(x,y,Z+0.72,Z+0.78,0.45,10,"wood")
    for (dx,dy) in ((0.8,0),(-0.8,0),(0,0.8),(0,-0.8)):
        pbox(x+dx-0.2,y+dy-0.2,x+dx+0.2,y+dy+0.2,Z+0.44,Z+0.48,"wood_dark")
        pbox(x+dx-0.2+(0.17 if dx<0 else 0),y+dy-0.2+(0.17 if dy<0 else 0),x+dx+0.2-(0.17 if dx>0 else 0),y+dy+0.2-(0.17 if dy>0 else 0),Z+0.48,Z+0.9,"wood_dark")
    cyl(x,y,Z,Z+2.4,0.035,6,"iron",top=False)
    for k in range(8):
        a0=2*math.pi*k/8; a1=2*math.pi*(k+1)/8; c="cream" if k%2 else col
        ptri("palette",(x+1.2*math.cos(a0),y+1.2*math.sin(a0),Z+2.15),(x+1.2*math.cos(a1),y+1.2*math.sin(a1),Z+2.15),(x,y,Z+2.6),c,(math.cos((a0+a1)/2),math.sin((a0+a1)/2),0.6))
        ptri("palette",(x+1.2*math.cos(a1),y+1.2*math.sin(a1),Z+2.15),(x+1.2*math.cos(a0),y+1.2*math.sin(a0),Z+2.15),(x,y,Z+2.6),c,(0,0,-1))
def bunting(p0,p1,rnd,sag=0.7,flags=14):
    prev=None; L=math.dist(p0[:2],p1[:2])
    for k in range(flags+1):
        t=k/flags; x=p0[0]+(p1[0]-p0[0])*t; y=p0[1]+(p1[1]-p0[1])*t; z=p0[2]-sag*4*t*(1-t); pt=(x,y,z)
        if prev:
            pquad("palette",prev,pt,(x,y,z-0.03),(prev[0],prev[1],prev[2]-0.03),"iron",(0,0,1)); pquad("palette",prev,pt,(x,y,z-0.03),(prev[0],prev[1],prev[2]-0.03),"iron",(0,0,-1))
            mx,my,mz=(prev[0]+x)/2,(prev[1]+y)/2,(prev[2]+z)/2; d=((x-prev[0]),(y-prev[1])); dl=math.hypot(*d) or 1; ux,uy=d[0]/dl,d[1]/dl; c=BUNT[k%len(BUNT)]
            tri=[(mx-ux*0.17,my-uy*0.17,mz),(mx+ux*0.17,my+uy*0.17,mz),(mx,my,mz-0.42)]
            for sgn in (1,-1): ptri("palette",tri[0],tri[1],tri[2],c,(-uy*sgn,ux*sgn,0))
        prev=pt
def string_lights(p0,p1,sag=0.9,n=16):
    for k in range(n+1):
        t=k/n; x=p0[0]+(p1[0]-p0[0])*t; y=p0[1]+(p1[1]-p0[1])*t; z=p0[2]-sag*4*t*(1-t)
        pbox(x-0.09,y-0.09,x+0.09,y+0.09,z-0.18,z,"lamp",b="lamp_glow")
        if k: 
            px=p0[0]+(p1[0]-p0[0])*(k-1)/n; py=p0[1]+(p1[1]-p0[1])*(k-1)/n; pz=p0[2]-sag*4*((k-1)/n)*(1-(k-1)/n)
            pbox(min(px,x)-0.01,min(py,y)-0.01,max(px,x)+0.01,max(py,y)+0.01,min(pz,z)-0.01,max(pz,z)+0.01,"iron")
import kit as _k
for _n in ["window","door","lantern_wall","fascia","blade","awning_bay","lamp","bench","planter","barrel","crates","bin_","umbrella_set","bunting","string_lights","shutter"]:
    globals()[_n]=_k.prof(_n,globals()[_n])
