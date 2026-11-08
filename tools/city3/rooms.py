"""Room pieces (reusable fittings built once at the origin) and parametric room templates.

A piece faces -Y (the 'front'), sits on z = 0 and is centred on x = y = 0. A template never builds
geometry: it queues kit.put() placements of pieces / CC0 assets and records seat anchors, so a room is
only a few KB of layout. Frame coordinates: u along the shop front, d = depth into the room (t = -d)."""
import math, os, random
from kit import *
import hero, press
import details
from details import FLOWERS

PIECES=["table_round","chair_wood","stool_wood","counter_2m","shelf_bottles_a","shelf_bottles_b","shelf_bottles_c","booth_2m","armchair_blue","armchair_red",
        "sofa_3","fireplace","rug_6x4","rug_4x3","floor_lamp","frames_wall","menu_board","display_table_a","display_table_b","shop_counter","shelf_goods_a","shelf_goods_b"]
_BUILT=[False]
# Real bottles (BlendSwap #33793, CC0, coldpengu) replace the coloured-box shelf stock. 4 shapes x 5 colours = 20 small library meshes.
BOTTLE_BLEND=os.path.join(HERE,"assets","blendswap","bottles_33793","pack.blend")
BOTTLE_SHAPES=(("Cube",0.32),("Cube.001",0.29),("Cube.002",0.22),("Cube.003",0.36))     # source object, height m (shape 2 is the squat jug)
BOTTLE_COLS={"green":(0.04,0.20,0.07),"amber":(0.36,0.16,0.03),"clear":(0.62,0.70,0.72),"cobalt":(0.04,0.09,0.34),"wine":(0.22,0.02,0.05)}
BOTTLE_KEYS=[f"bottle_{i}_{c}" for i in range(4) for c in BOTTLE_COLS]
_PART_MATS={}
def _part_mat(name,rgb,rough,img=None):
    """Shared decoration materials (liquid / cork / label), created once."""
    if name in _PART_MATS: return _PART_MATS[name]
    import bpy
    m=bpy.data.materials.new(name); m.use_nodes=True
    b=m.node_tree.nodes["Principled BSDF"]; b.inputs["Roughness"].default_value=rough; b.inputs["Metallic"].default_value=0.0
    if img:
        t=m.node_tree.nodes.new("ShaderNodeTexImage"); t.image=bpy.data.images.load(img)
        m.node_tree.links.new(t.outputs["Color"],b.inputs["Base Color"])
    else: b.inputs["Base Color"].default_value=(*rgb,1)
    _PART_MATS[name]=m; return m
def _join_part(obj,verts,faces,mat,uvs=None):
    """Append one decoration part to a library object: build a temp mesh from
    raw geometry (bottle_spec output, Blender space) and join it in, so the
    part becomes an extra material slot / glTF primitive of the SAME mesh —
    the console's one-InstancedMesh-per-mesh mapping is untouched."""
    import bpy
    me=bpy.data.meshes.new("part"); me.from_pydata(verts,[],faces); me.update()
    if uvs:
        lay=me.uv_layers.new(name="UVMap")
        flat=[c for f in faces for vi in f for c in (uvs[vi][0],1.0-uvs[vi][1])]   # spec UVs are glTF-style (v=0 top); Blender wants v=0 bottom
        lay.data.foreach_set("uv",flat)
    me.materials.append(mat)
    po=bpy.data.objects.new("part",me); bpy.context.scene.collection.objects.link(po)
    for o in bpy.context.selected_objects: o.select_set(False)
    obj.select_set(True); po.select_set(True); bpy.context.view_layer.objects.active=obj
    bpy.ops.object.join()
def decorate_bottle(obj,shape,fam,key):
    """Glass alpha + liquid + label + cork for one bottle variant, all from
    bottle_spec (the same tables the GLB bridge applies)."""
    import bottle_spec as spec
    b=obj.data.materials[0].node_tree.nodes["Principled BSDF"]
    b.inputs["Alpha"].default_value=spec.FAMILIES[fam]["glass_alpha"]
    for attr,val in (("surface_render_method","BLENDED"),("blend_method","BLEND")):
        try: setattr(obj.data.materials[0],attr,val)
        except Exception: pass
    prof=spec.profile_from_points([tuple(v.co) for v in obj.data.vertices],step=0.01)
    top=max(v.co.z for v in obj.data.vertices)   # exact lip height (the profile grid rounds to 1 cm)
    lv,lf=spec.liquid_geometry(prof,spec.fill_for(key,shape))
    _join_part(obj,lv,lf,_part_mat(f"LQ_{fam}",spec.FAMILIES[fam]["liquid"],spec.LIQUID_ROUGH))
    lab_png=os.path.join(HERE,"tex","labels",f"{fam}.png")
    if not os.path.exists(lab_png):
        raise RuntimeError(f"missing label art {lab_png} — generate it with system python first: "
                           "python3 -c \"import bottle_spec,os; [open(f'tex/labels/{f}.png','wb').write(bottle_spec.make_label_png(f)) for f in bottle_spec.FAMILIES]\" "
                           "(PIL lives outside Blender in this pipeline, like textures.py)")
    z0,z1=spec.SHAPES[shape]["label"]; rband=max(r for (z,r) in prof if z0-0.01<=z<=z1+0.01)
    gv,gf,guv=spec.label_geometry(rband,z0,z1)
    _join_part(obj,gv,gf,_part_mat(f"LABEL_{fam}",None,spec.LABEL_ROUGH,img=lab_png),uvs=guv)
    neck_r=min(r for (z,r) in prof if z>=top-0.012 and r>0.005)
    cv,cf=spec.cork_geometry(neck_r,top)
    _join_part(obj,cv,cf,_part_mat("CORK",spec.CORK_RGB,spec.CORK_ROUGH))
def build_bottles():
    import assets_kit
    for i,(nm,h) in enumerate(BOTTLE_SHAPES):
        for c,rgb in BOTTLE_COLS.items():
            k=f"bottle_{i}_{c}"
            if k not in assets_kit.LIB:
                assets_kit.load_blend(k,BOTTLE_BLEND,nm,h,rgb,rough=0.12 if c!="clear" else 0.05,src_id="blendswap:33793")
                decorate_bottle(assets_kit.LIB[k]["obj"],i,c,k)
def _origin(): return Frame((0,0),(1,0),(0,-1),0.0)
def piece(name,fn):
    with grp("LIB_"+name): fn(_origin())
def build_pieces():
    if _BUILT[0]: return
    _BUILT[0]=True; ANCHORS_ON[0]=False; r=random.Random(21); build_bottles()
    from drinking_glasses import install_library
    install_library()
    piece("table_round",lambda fr:hero.table(fr,0,0,0,r,0.0,skip=("+u","-u","+d","-d")))
    piece("chair_wood",lambda fr:hero.chair(fr,0,0,0,"+d"))
    def stool(fr): cyl(0,0,0,0.62,0.04,6,"iron",top=False); cyl(0,0,0.62,0.68,0.21,8,"wood_dark")
    piece("stool_wood",stool)
    def counter(fr): fbox(fr,-1.0,1.0,-0.45,0.45,0,1.05,"wood_dark"); fbox(fr,-1.05,1.05,-0.57,0.57,1.05,1.12,"wood")
    piece("counter_2m",counter)
    def shelf_b(seed):
        def f(fr):
            rr=random.Random(seed); fbox(fr,-1.0,1.0,-0.14,0.0,0,3.1,"wood_dark")                  # back panel on the wall side (t < 0)
            for zs in (1.1,1.8,2.5):
                fbox(fr,-1.0,1.0,0.0,0.6,zs,zs+0.05,"wood"); u=-0.9
                pass                                                                         # bottles are real library meshes, see stock_bottles()
        return f
    for nm,s in (("shelf_bottles_a",1),("shelf_bottles_b",2),("shelf_bottles_c",3)): piece(nm,shelf_b(s))
    def booth(fr): fbox(fr,-1.0,1.0,-1.05,0.0,0,0.46,"cloth_red"); fbox(fr,-1.0,1.0,-1.05,-0.95,0.46,0.95,"cloth_red")
    piece("booth_2m",booth)
    piece("armchair_blue",lambda fr:hero.armchair(fr,0,0,0,"-d","cloth_blue")); piece("armchair_red",lambda fr:hero.armchair(fr,0,0,0,"-d","cloth_red"))
    def sofa(fr): fbox(fr,-1.5,1.5,-0.75,0.0,0,0.5,"cloth_gold"); fbox(fr,-1.5,1.5,-0.75,-0.6,0.5,1.0,"cloth_gold")
    piece("sofa_3",sofa)
    def fire(fr):
        fbox(fr,-0.9,0.9,-1.3,0.0,0,1.4,"stone"); fbox(fr,-1.0,1.0,-1.4,0.1,1.4,1.5,"wood_dark"); fbox(fr,-0.8,0.8,-1.3,0.02,0.05,0.9,"ink")
        fbox(fr,-0.55,0.55,-1.2,-0.1,0.05,0.5,"fire",b="lamp_glow"); fbox(fr,-0.8,0.8,-1.3,0.0,1.5,4.2,"stone")
    piece("fireplace",fire)
    for nm,w,d in (("rug_6x4",3.2,2.2),("rug_4x3",2.0,1.5)):
        piece(nm,lambda fr,w=w,d=d:tq("rug",[fr.p(-w,-d,0.04),fr.p(w,-d,0.04),fr.p(w,d,0.04),fr.p(-w,d,0.04)],[(0,0),(1,0),(1,1),(0,1)],(0,0,1)))
    def fl(fr): cyl(0,0,0,1.6,0.03,6,"iron",top=False); cyl(0,0,1.6,1.95,0.2,8,"lamp",b="lamp_glow",r1=0.12)
    piece("floor_lamp",fl)
    def frames(fr):
        for k,c in enumerate(("crimson","teal","yellow")): fbox(fr,-0.9+k*0.62,-0.4+k*0.62,-0.05,0,1.8,2.4,"wood_dark"); fbox(fr,-0.84+k*0.62,-0.46+k*0.62,-0.02,0.0,1.86,2.34,c)
    piece("frames_wall",frames)
    def menu(fr): tq("signs",[fr.p(-0.9,0.02,2.0),fr.p(0.9,0.02,2.0),fr.p(0.9,0.02,2.5),fr.p(-0.9,0.02,2.5)],details.sign_cell(14),fr.o(0,1))
    piece("menu_board",menu)
    def disp(seed):
        def f(fr):
            rr=random.Random(seed); fbox(fr,-0.8,0.8,-0.4,0.4,0.0,0.9,"wood"); fbox(fr,-0.85,0.85,-0.45,0.45,0.9,0.95,"wood_dark")
            for k in range(6): fbox(fr,-0.7+k*0.25,-0.58+k*0.25,-0.3+(k%2)*0.35,-0.12+(k%2)*0.35,0.95,0.95+rr.uniform(0.15,0.3),rr.choice(["crimson","orange","yellow","lime","magenta","teal","cloth_blue"]))
        return f
    piece("display_table_a",disp(5)); piece("display_table_b",disp(6))
    def cashier(fr):
        fbox(fr,-1.2,1.2,-0.45,0.45,0,1.0,"wood_dark"); fbox(fr,-1.25,1.25,-0.5,0.5,1.0,1.06,"wood"); fbox(fr,0.5,0.95,-0.2,0.2,1.06,1.3,"brass"); fbox(fr,-1.0,-0.4,-0.18,0.18,1.06,1.2,"paper")
    piece("shop_counter",cashier)
    def goods(seed):
        def f(fr):
            rr=random.Random(seed); fbox(fr,-1.0,1.0,-0.1,0.0,0,2.6,"wood_dark")
            for zs in (0.4,1.0,1.6,2.2):
                fbox(fr,-1.0,1.0,0.0,0.5,zs,zs+0.05,"wood"); u=-0.92
                while u<0.8: w=rr.uniform(0.15,0.32); fbox(fr,u,u+w,0.1,0.4,zs+0.05,zs+0.05+rr.uniform(0.15,0.3),rr.choice(["cloth_red","cloth_blue","cloth_gold","cloth_green","paper","terracotta","brick","cream"])); u+=w+0.04
        return f
    piece("shelf_goods_a",goods(8)); piece("shelf_goods_b",goods(9))
    ANCHORS_ON[0]=True
# ---------------- templates ----------------
def stock_bottles(fr,u,d,f,seed):
    """Fill one 2 m shelf (3 rows at z 1.15/1.85/2.55 above floor f) with real bottles; deterministic per shelf."""
    rr=random.Random(seed*7919+int(u*13)); pal=list(BOTTLE_COLS)
    for zs in (1.15,1.85,2.55):
        x=-0.88; fav=rr.choice(pal)
        while x<0.88:
            sh=rr.randrange(4) if rr.random()<0.8 else 2; col=fav if rr.random()<0.55 else rr.choice(pal)
            put(f"bottle_{sh}_{col}",fr,u+x,-(d-0.26),f+zs,0,1); x+=rr.uniform(0.13,0.2)
def _lane(db,bw): return db*bw+bw/2
def seat_table(fr,u,d,f,rnd,chairs):
    put("table_round",fr,u,-d,f)
    for (du,dd) in chairs:
        put("chair_wood",fr,u+du,-(d+dd),f,-du,dd); add_anchor(fr,u+du,-(d+dd),-du,dd,0.49,"chair",f,side=-1)
FOUR=((0.78,0),(-0.78,0),(0,0.78),(0,-0.78)); TWO_SIDE=((0.78,0),(-0.78,0)); TWO_FB=((0,0.78),(0,-0.78))
def lanterns(fr,W,D,GH,n_u,rows):
    for d in rows:
        for k in range(n_u): put("lantern_hang",fr,W*(k+0.7)/(n_u+0.4),-d,GH)
def plants(fr,W,D,f,corners=((0.9,1.0),)):
    for (u,d) in corners: put("potted_plant_02",fr,u,-d,f)
def cafe(bd,fr,W,D,GH,rnd,f,db,bw,lounge=False):
    build_pieces(); press.build_pieces(rnd); c=_lane(db,bw)
    bar_end=min(W*0.56,W-3.0) if W>=14 else W-3.2; nseg=max(1,int((bar_end-2.0)/2.0)); bar_d=D-3.15; shelf_d=D-0.45
    for i in range(nseg):
        u=2.0+1.0+2.0*i; put("counter_2m",fr,u,-bar_d,f)
        if i==0: put("CashRegister_01",fr,u+0.45,-bar_d,f+1.12,0,-1)                 # CC0 props sit on the counter top (z 1.12)
        elif i%2==1: put("ceramic_pot",fr,u+0.5,-bar_d,f+1.12,0,-1,0.45)
        else: put("brass_goblets",fr,u-0.3,-bar_d,f+1.12,0,-1)
        put("stool_wood",fr,u-0.5,-(bar_d-1.0),f,0,-1); add_anchor(fr,u-0.5,-(bar_d-1.0),0,-1,0.68,"stool",f,side=-1)
        put("stool_wood",fr,u+0.5,-(bar_d-1.0),f,0,-1); add_anchor(fr,u+0.5,-(bar_d-1.0),0,-1,0.68,"stool",f,side=-1)
    for i in range(int((W-2.0)//2.0)):
        put(("shelf_bottles_a","shelf_bottles_b","shelf_bottles_c")[i%3],fr,1.0+1.0+2.0*i,-shelf_d,f,0,1); stock_bottles(fr,1.0+1.0+2.0*i,shelf_d,f,i+1)
    for dd,u0,chairs in ((3.4,2.3,None),(5.8,4.1,"back")):
        u=u0
        while u<W-2.0:
            if (abs(u-c)>1.2 or dd>4) and (dd<4 or u<bar_end-1.0): seat_table(fr,u,dd,f,rnd,(FOUR if rnd.random()<0.5 else (TWO_SIDE if rnd.random()<0.5 else TWO_FB)) if chairs is None else TWO_SIDE)   # back row never takes the bar-side chair: its stand point would meet the stools'
            u+=3.6
    for k in range(max(1,round(W/4.0))):                                                    # window booths (not in the door bay)
        if k==db: continue
        bc=k*bw+bw/2; put("booth_2m",fr,bc,-1.4,f,0,-1)
        for su in (bc-0.6,bc+0.6): add_anchor(fr,su,-0.85,0,-1,0.46,"booth",f)
    if lounge and W>=18:
        cu,cd=W*0.8,D/2; put("rug_6x4",fr,cu-0.4,-cd,f,0,1); put("armchair_blue",fr,cu-0.4,-(cd+1.6),f,0,1); add_anchor(fr,cu-0.4,-(cd+1.6),0,1,0.46,"armchair",f)
        put("armchair_red",fr,cu-0.4,-(cd-1.6),f,0,-1); add_anchor(fr,cu-0.4,-(cd-1.6),0,-1,0.46,"armchair",f)
        put("sofa_3",fr,cu-2.4,-cd,f,1,0)
        for sd in (-1.0,0.0,1.0): add_anchor(fr,cu-2.4,-(cd+sd),1,0,0.5,"sofa",f)
        put("fireplace",fr,W-1.6,-cd,f,-1,0); put("floor_lamp",fr,W-1.0,-(D-1.2),f); put("table_round",fr,cu-0.4,-cd,f)
        add_interactable(fr,"radio","vintage_radio_transceiver","Radio",cu+0.06,-cd,f+0.78,1,0,cu+0.55,-cd,f,pilot=(0.16,0.152,0.03))   # at the lounge table's near edge, panel ~6 cm past it: the walker body is 0.4 m, so the stand point is >= 0.45 m off the table box, and the Interact clip's hand reaches only ~0.27 m past the hips
    put("menu_board",fr,0.32,-4.1,f,1,0); put("frames_wall",fr,0.32,-7.4,f,1,0)
    plants(fr,W,D,f,((0.9,1.0),(W-0.9,D-1.0))); lanterns(fr,W,D,GH,max(2,int(W//6)),(3.0,7.0))
def shop(bd,fr,W,D,GH,rnd,f,db,bw):
    build_pieces(); press.build_pieces(rnd); c=_lane(db,bw); a=("shelf_goods_a","shelf_goods_b")
    for i in range(int((W-2.0)//2.0)): put(a[i%2],fr,2.0+2.0*i,-(D-0.42),f,0,1)
    cu=min(W-3.0,c+3.2) if c+3.2<W-2.0 else max(3.0,c-3.2); put("shop_counter",fr,cu,-(D-3.2),f,0,1)
    put("metal_jug",fr,cu-0.9,-(D-3.2),f+1.06,0,1); put("brass_goblets",fr,cu+0.1,-(D-3.2),f+1.06,0,1)
    add_anchor(fr,cu,-(D-4.0),0,-1,0.0,"stand",f,side=-1); add_anchor(fr,cu,-(D-2.5),0,1,0.0,"stand",f,side=-1)     # customer / clerk; each walks in from behind
    for dd in (3.2,6.0):
        u=2.4+(1.8 if dd>5 else 0)
        while u<W-2.0:
            if (abs(u-c)>1.3 or dd>5) and abs(u-cu)>1.9: put(("display_table_a","display_table_b")[int(u)%2],fr,u,-dd,f,0,1); add_anchor(fr,u,-(dd+0.9),0,1,0.0,"stand",f,side=-1)
            u+=3.4
    for (u,d) in ((0.8,2.0),(W-0.8,2.4),(W-0.8,4.2)): put("wooden_crate_01",fr,u,-d,f)
    for (u,d) in ((0.8,3.3),(W-1.5,D-1.6)): put("ink_barrel",fr,u,-d,f)
    plants(fr,W,D,f,((W-0.9,1.0),)); lanterns(fr,W,D,GH,max(2,int(W//6)),(3.0,7.0))
def library(bd,fr,W,D,GH,rnd,f,db,bw):
    build_pieces(); press.build_pieces(rnd); c=_lane(db,bw)
    nb=int((W-1.4)//1.7)
    for i in range(nb):
        u=1.2+0.85+1.7*i; put("wooden_bookshelf_worn",fr,u,-(D-0.62),f,0,1); put(("books_a","books_b","books_c")[i%3],fr,u,-(D-0.62),f,0,1)
    for dd in (3.4,7.2):
        u=2.4
        while u<(W-5.6 if dd<5 else W-2.4):                 # keep the front-right corner for the armchairs
            if abs(u-c)>1.3 or dd>5: seat_table(fr,u,dd,f,rnd,TWO_FB if rnd.random()<0.6 else TWO_SIDE)
            u+=3.8
    put("rug_4x3",fr,W-2.6,-2.2,f,0,1)
    for (u,du) in ((W-1.6,0),(W-3.6,0)): put("armchair_blue",fr,u,-2.2,f,0,-1); add_anchor(fr,u,-2.2,0,-1,0.46,"armchair",f)
    put("vintage_grandfather_clock_01",fr,W-0.9,-(D-0.55),f,0,1); put("floor_lamp",fr,W-0.9,-1.0,f)
    plants(fr,W,D,f,((0.9,1.0),)); lanterns(fr,W,D,GH,max(2,int(W//6)),(3.0,7.0))
def workshop(bd,fr,W,D,GH,rnd,f,db,bw):
    build_pieces(); press.build_pieces(rnd); c=_lane(db,bw)
    for i in range(int((W-2.0)//2.4)):
        u=1.8+2.4*i
        if abs(u-c)<1.3 and i%2==0: continue
        put("press_desk",fr,u,-4.2,f); add_anchor(fr,u,-3.2,0,-1,0.0,"stand",f,side=-1)
    for i in range(int((W-2.0)//2.0)): put(("shelf_goods_a","shelf_goods_b")[i%2],fr,2.0+2.0*i,-(D-0.42),f,0,1)
    for (u,d) in ((0.8,2.0),(0.8,3.2),(W-0.8,2.4),(W-0.8,6.0)): put("wooden_crate_01",fr,u,-d,f)
    for (u,d) in ((W-1.6,3.2),(W-1.6,4.6),(1.4,D-1.6)): put("ink_barrel",fr,u,-d,f)
    put("wooden_bookshelf_worn",fr,W*0.5,-(D-0.62),f,0,1); lanterns(fr,W,D,GH,max(2,int(W//6)),(3.0,7.0))
TEMPLATES={"cafe":cafe,"tea":lambda *a:cafe(*a,lounge=True),"shop":shop,"library":library,"workshop":workshop}
