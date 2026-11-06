"""Kronikler Press — the Verse's archive and newsroom (Kronos 'Kronikler' keeps the living digest).
Procedural fittings go to the PressInterior group; CC0 library assets are queued with kit.put()."""
import math, random
from kit import *
from details import FLOWERS
def books_on_shelf(cx,cy,fx,fy,z0,width,depth,rnd,levels):
    r=(-fy,fx); fr=Frame((cx,cy),r,(fx,fy))
    for zl in levels:
        u=-width/2+0.04
        while u<width/2-0.06:
            w=rnd.uniform(0.035,0.07); h=rnd.uniform(0.2,0.29)
            if rnd.random()<0.08: u+=0.12; continue                        # gaps read as a used shelf
            fbox(fr,u,u+w,-depth/2+0.03,depth/2-0.05,z0+zl,z0+zl+h,rnd.choice(["door_red","door_blue","door_green","wood_dark","gold","paper","brick","teal","purple"]))
            u+=w+0.004
def desk(fr,u,d,f,rnd):
    fbox(fr,u-0.8,u+0.8,-d-0.4,-d+0.4,f+0.72,f+0.77,"wood"); fbox(fr,u+0.25,u+0.75,-d-0.36,-d+0.36,f,f+0.72,"wood_dark")
    for (a,b) in ((-0.74,-0.34),(-0.74,0.34)): fbox(fr,u+a-0.03,u+a+0.03,-d+b-0.03,-d+b+0.03,f,f+0.72,"wood_dark",top=False)
    for k in range(3): fbox(fr,u+0.27,u+0.73,-d+0.37,-d+0.38,f+0.08+k*0.22,f+0.26+k*0.22,"wood")
    for k in range(rnd.randint(2,4)):                                               # paper on the desk
        su=u-0.6+k*0.28; pquad("palette",fr.p(su,-d-0.12,f+0.775+k*0.001),fr.p(su+0.22,-d-0.12,f+0.775+k*0.001),fr.p(su+0.22,-d+0.18,f+0.775+k*0.001),fr.p(su,-d+0.18,f+0.775+k*0.001),"paper",(0,0,1))
def press_machine(fr,u,d,f):
    """A flatbed cylinder press: iron bed, two side frames, three rollers, feed board and flywheel."""
    fbox(fr,u-1.6,u+1.6,-d-0.8,-d+0.8,f,f+0.85,"iron"); fbox(fr,u-1.7,u+1.7,-d-0.9,-d+0.9,f+0.85,f+0.92,"grey")
    for su in (u-1.4,u+1.4): fbox(fr,su-0.12,su+0.12,-d-0.85,-d+0.85,f+0.92,f+1.9,"iron")
    for (t,z,r) in ((-d,f+1.35,0.32),(-d-0.45,f+1.12,0.18),(-d+0.45,f+1.12,0.18)): hcyl(fr,u-1.3,u+1.3,t,z,r,"grey" if r>0.3 else "ink")
    fbox(fr,u-1.4,u+1.4,-d-0.8,-d+0.8,f+1.9,f+2.0,"iron")
    pquad("palette",fr.p(u-1.2,-d+0.9,f+1.0),fr.p(u+1.2,-d+0.9,f+1.0),fr.p(u+1.2,-d+1.6,f+0.8),fr.p(u-1.2,-d+1.6,f+0.8),"paper",(0,0,1))   # feed board
    for k in range(6): pquad("palette",fr.p(u-1.0,-d+0.95,f+1.0+k*0.01),fr.p(u+1.0,-d+0.95,f+1.0+k*0.01),fr.p(u+1.0,-d+1.5,f+0.85+k*0.01),fr.p(u-1.0,-d+1.5,f+0.85+k*0.01),"paper",(0,0,1))
    x,y=fr.xy(u+1.75,-d); seg=14; R=0.7; z0=fr.z0+f+1.2                                  # flywheel on the side
    for k in range(seg):
        a0=2*math.pi*k/seg; a1=2*math.pi*(k+1)/seg
        for (r0,r1) in ((R-0.09,R),):
            p=lambda rr,a:(x+fr.r[0]*0+fr.n[0]*rr*math.cos(a),y+fr.n[1]*rr*math.cos(a),z0+rr*math.sin(a))
            for sgn in (1,-1): pquad("palette",p(r0,a0),p(r1,a0),p(r1,a1),p(r0,a1),"brass",fr.o(sgn,0))
    for k in range(4):
        a=math.pi/2*k+0.3
        for sgn in (1,-1): pquad("palette",(x,y,z0),(x+fr.n[0]*R*math.cos(a),y+fr.n[1]*R*math.cos(a),z0+R*math.sin(a)),(x+fr.n[0]*R*math.cos(a+0.12),y+fr.n[1]*R*math.cos(a+0.12),z0+R*math.sin(a+0.12)),(x,y,z0+0.01),"brass",fr.o(sgn,0))
    for (du,dd) in ((-2.3,0.6),(-2.3,-0.4),(2.6,1.0)): ink_barrel(fr,u+du,d+dd,f)
def ink_barrel(fr,u,d,f):
    x,y=fr.xy(u,-d); cyl(x,y,fr.z0+f,fr.z0+f+0.85,0.3,8,"ink"); cyl(x,y,fr.z0+f+0.2,fr.z0+f+0.25,0.315,8,"iron",top=False); cyl(x,y,fr.z0+f+0.6,fr.z0+f+0.65,0.315,8,"iron",top=False)
def drying_line(fr,u0,u1,d,z,rnd,n):
    pts=[fr.p(u0,-d,z),fr.p(u1,-d,z)]
    pquad("palette",pts[0],pts[1],fr.p(u1,-d,z-0.02),fr.p(u0,-d,z-0.02),"iron",fr.o(0,1)); pquad("palette",pts[0],pts[1],fr.p(u1,-d,z-0.02),fr.p(u0,-d,z-0.02),"iron",fr.o(0,-1))
    for k in range(n):
        su=u0+0.4+k*(u1-u0-0.8)/max(1,n-1); w=0.42; tilt=rnd.uniform(-0.06,0.06)
        q=[fr.p(su-w/2,-d+tilt,z-0.62),fr.p(su+w/2,-d-tilt,z-0.62),fr.p(su+w/2,-d-tilt,z-0.03),fr.p(su-w/2,-d+tilt,z-0.03)]
        tq("newsprint",q,[(0,0),(1,0),(1,1),(0,1)],fr.o(0,1))
        qb=[fr.p(su+w/2,-d-tilt-0.004,z-0.62),fr.p(su-w/2,-d+tilt-0.004,z-0.62),fr.p(su-w/2,-d+tilt-0.004,z-0.03),fr.p(su+w/2,-d-tilt-0.004,z-0.03)]
        tq("newsprint",qb,[(0,0),(1,0),(1,1),(0,1)],fr.o(0,-1))                       # the other page, read the right way round
def interior(bd,fr,W,D,GH,rnd,f,db,bw):
    T=0.3
    with grp("PressInterior"):
        press_machine(fr,W*0.68,6.2,f)
        add_anchor(fr,W*0.68-2.0,-4.6,0.55,-0.45,0.0,"stand",f); add_anchor(fr,W*0.68+0.4,-4.4,0,-1,0.0,"stand",f)
        for (u,d) in ((W*0.68-2.6,8.8),(W*0.68-1.7,9.1),(W*0.68+2.4,8.6)):                      # paper crates (CC0) + stacks
            put("wooden_crate_01",fr,u,-d,f,0,1)
        for k,(u,d) in enumerate(((W*0.68+3.2,4.2),(W*0.68+3.7,4.6))):
            for j in range(6): fbox(fr,u-0.32,u+0.32,-d-0.24,-d+0.24,f+j*0.09,f+j*0.09+0.085,"paper" if j%2 else "cream")
        drying_line(fr,W*0.48,W-0.6,3.4,f+2.85,rnd,9); drying_line(fr,W*0.48,W-0.6,4.3,f+2.85,rnd,9)
        # newsroom: four editors' desks with lamps, binders, a radio, the encyclopaedia
        for i,(u,d) in enumerate(((2.6,3.6),(5.4,3.6),(2.6,6.6),(5.4,6.6))):
            desk(fr,u,d,f,rnd)
            put("ChairCushioned",fr,u,-(d+1.0),f,0,1); add_anchor(fr,u,-(d+0.95),0,1,0.46,"chair",f)
            put("desk_lamp_arm_01",fr,u-0.55,-(d-0.15),f+0.77,0.4,1)
            put("binder_notebook",fr,u-0.05,-(d+0.05),f+0.775,0,1)
            if i==1: put("vintage_radio_transceiver",fr,u+0.45,-(d-0.1),f+0.77,0,1)
            if i==2: put("book_encyclopedia_set_01",fr,u+0.4,-(d-0.2),f+0.77,0,1)
        # back wall archive: Poly Haven shelves filled with books, drawer cabinets between them
        sx=[1.4,3.1,6.6,8.3]; bd_=D-T-0.32
        for u in sx:
            put("wooden_bookshelf_worn",fr,u,-bd_,f,0,1)
            x,y=fr.xy(u,-bd_); fx,fy,_=fr.o(0,1)
            books_on_shelf(x,y,fx,fy,fr.z0+f,1.25,0.5,rnd,[0.08,0.4,0.73,1.06,1.39,1.72])
        for u in (4.85,): put("drawer_cabinet",fr,u,-(D-T-0.27),f,0,1)
        put("vintage_grandfather_clock_01",fr,10.2,-(D-T-0.25),f,0,1)
        put("wall_clock",fr,W-T-0.03,-6.0,f+2.6,-1,0)
        # reading corner by the front windows
        for (u,du) in ((W-2.0,-1),(W-3.4,1)):
            put("ArmChair_01",fr,u,-1.4,f,0,-1); add_anchor(fr,u,-1.4,0,-1,0.45,"armchair",f)          # backs to the window, facing the room
        put("WoodenTable_02",fr,W-2.7,-1.3,f,0,1); put("vintage_oil_lamp",fr,W-2.7,-1.3,f+0.418,0,1)
        put("potted_plant_02",fr,0.9,-1.0,f,0,1); put("potted_plant_02",fr,W-0.9,-(D-1.2),f,0,1)
        # hanging lanterns
        for (u,d) in ((W*0.2,3.0),(W*0.4,3.0),(W*0.2,7.0),(W*0.4,7.0),(W*0.62,2.6),(W*0.85,2.6)):
            x,y=fr.xy(u,-d); cyl(x,y,fr.z0+GH-0.9,fr.z0+GH,0.012,4,"iron",top=False); pbox(x-0.17,y-0.17,x+0.17,y+0.17,fr.z0+GH-1.25,fr.z0+GH-0.9,"lamp",b="lamp_glow"); pbox(x-0.2,y-0.2,x+0.2,y+0.2,fr.z0+GH-0.92,fr.z0+GH-0.85,"iron")
