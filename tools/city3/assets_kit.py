"""Import CC0 assets (Poly Haven glTF, Quaternius FBX) into Blender as reusable library meshes.

Each asset becomes ONE mesh object (parts joined, transforms applied, origin at the bottom centre),
decimated to a triangle budget, with textures resized to <= TEX px. Placements are linked
duplicates (obj.copy()), so the glTF export writes each mesh once and references it per node."""
import bpy, math, os
from mathutils import Vector
HERE=os.path.dirname(os.path.abspath(__file__))
PH=os.path.join(HERE,"assets","polyhaven")
QT=os.path.join(HERE,"assets","quaternius","Furniture Pack by @Quaternius","FBX")
TEX=512
LIB={}
def _lib_collection():
    c=bpy.data.collections.get("AssetLibrary")
    if not c: c=bpy.data.collections.new("AssetLibrary"); bpy.context.scene.collection.children.link(c)
    return c
def _tris(o): return sum(len(p.vertices)-2 for p in o.data.polygons)
def _diffuse_only(obj):
    """Streaming budget: keep each material's base-colour texture, drop normal/ARM maps, use constant roughness.
    Three maps per Poly Haven asset would triple texture memory for detail nobody sees from a spectator camera."""
    for slot in obj.material_slots:
        m=slot.material
        if not m or not m.use_nodes: continue
        nt=m.node_tree; b=next((n for n in nt.nodes if n.type=='BSDF_PRINCIPLED'),None)
        if not b: continue
        keep=set()
        for l in nt.links:
            if l.to_node==b and l.to_socket.name=='Base Color':
                src=l.from_node
                while src and src.type not in ('TEX_IMAGE',):
                    ins=[x for x in src.inputs if x.is_linked]; src=ins[0].links[0].from_node if ins else None
                if src: keep.add(src)
        for n in list(nt.nodes):
            if n.type in ('TEX_IMAGE','NORMAL_MAP','SEPARATE_COLOR','MIX','MAPPING','TEX_COORD','MATH') and n not in keep and n.type!='TEX_IMAGE':
                pass
        for l in list(nt.links):
            if l.to_node==b and l.to_socket.name in ('Normal','Roughness','Metallic'): nt.links.remove(l)
        for n in list(nt.nodes):
            if n.type=='TEX_IMAGE' and n not in keep: nt.nodes.remove(n)
            elif n.type=='NORMAL_MAP': nt.nodes.remove(n)
        b.inputs['Roughness'].default_value=0.8; b.inputs['Metallic'].default_value=0.0
def load(asset_id,budget,source="polyhaven",name=None,tex=None):
    key=name or asset_id
    if key in LIB: return LIB[key]
    before=set(bpy.data.objects); imgs_before=set(bpy.data.images)
    if source=="polyhaven": bpy.ops.import_scene.gltf(filepath=os.path.join(PH,asset_id,f"{asset_id}_1k.gltf"))
    elif source=="usdz":
        # every cup's USDZ holds textures/Texture_4_ffffff.png; importing the .usdz directly unpacks into one shared temp dir and
        # the importer reuses the first image with that path, so all cups came out red. Unpack each asset into its own folder.
        import zipfile; dst=os.path.join(HERE,"assets","_usdx",key); zf=zipfile.ZipFile(os.path.join(HERE,"assets",asset_id+".usdz"))
        if not os.path.isdir(dst): zf.extractall(dst)
        root=[n for n in zf.namelist() if "/" not in n and n.rsplit(".",1)[-1] in ("usda","usdc","usd")][0]
        bpy.ops.wm.usd_import(filepath=os.path.join(dst,root))
        for img in set(bpy.data.images)-imgs_before: img.name=f"{key}_{img.name}"
    elif source=="sketchfab": bpy.ops.import_scene.gltf(filepath=os.path.join(HERE,"assets","sketchfab",asset_id,"scene.gltf"))
    elif source=="blendkit":
        # BlenderKit downloads stay local (see .gitignore): append the file's mesh
        # objects, skipping demo ground discs (a "Ground" material slot gives them away).
        with bpy.data.libraries.load(os.path.join(HERE,"assets","blendkit",asset_id), link=False) as (src, dst):
            dst.objects = list(src.objects)   # names inside the with-block; real objects after it
        for o in dst.objects:
            if o.type != "MESH" or any(s.material and (s.material.name == "Ground" or s.material.name.startswith("Ground.")) for s in o.material_slots):
                bpy.data.objects.remove(o, do_unlink=True)
            else:
                _lib_collection().objects.link(o)
    else: bpy.ops.import_scene.fbx(filepath=os.path.join(QT,f"{asset_id}.fbx"))
    new=[o for o in bpy.data.objects if o not in before]
    new_names=[o.name for o in new]
    meshes=[o for o in new if o.type=="MESH"]
    for o in bpy.context.selected_objects: o.select_set(False)
    for o in meshes: o.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0]
    if len(meshes)>1: bpy.ops.object.join()
    obj=bpy.context.view_layer.objects.active
    if source=="usdz": mw=obj.matrix_world.copy(); obj.parent=None; obj.matrix_world=mw   # USD's Y-up fix lives on the parent Empty
    else: obj.parent=None
    bpy.ops.object.transform_apply(location=True,rotation=True,scale=True)
    for nm in new_names:                                  # joined parts are already gone; drop leftover empties
        o=bpy.data.objects.get(nm)
        if o is not None and o is not obj: bpy.data.objects.remove(o,do_unlink=True)
    raw=_tris(obj)
    if raw>budget:
        m=obj.modifiers.new("dec","DECIMATE"); m.ratio=max(0.02,budget/raw); m.use_collapse_triangulate=True
        bpy.ops.object.modifier_apply(modifier=m.name)
    # origin -> bottom centre
    vs=[v.co for v in obj.data.vertices]; mn=Vector([min(v[i] for v in vs) for i in range(3)]); mx=Vector([max(v[i] for v in vs) for i in range(3)])
    off=Vector(((mn.x+mx.x)/2,(mn.y+mx.y)/2,mn.z))
    for v in obj.data.vertices: v.co-=off
    obj.location=(0,0,0); obj.name=f"LIB_{key}"; obj.data.name=f"LIB_{key}"
    for c in list(obj.users_collection): c.objects.unlink(obj)
    _lib_collection().objects.link(obj)
    if source in ("polyhaven","usdz"): _diffuse_only(obj)
    T=tex or TEX
    for img in set(bpy.data.images)-imgs_before:
        if img.size[0]>T: img.scale(T,max(1,int(img.size[1]*T/img.size[0])))
    if source=="quaternius": _recolor(obj)
    LIB[key]={"obj":obj,"dims":tuple(round(d,3) for d in (mx-mn)),"tris_raw":raw,"tris":_tris(obj),"source":source,"id":asset_id}
    return LIB[key]
QCOL=[("darkwood",(0.20,0.11,0.05)),("wood",(0.55,0.33,0.17)),("page",(0.86,0.80,0.66)),("cover",None),("sofa",(0.10,0.18,0.42)),
      ("cushion",(0.10,0.18,0.42)),("fabric",(0.10,0.18,0.42)),("metal",(0.06,0.06,0.07)),("leaf",(0.10,0.32,0.10)),("plant",(0.10,0.32,0.10)),("pot",(0.55,0.22,0.10)),("lamp",(0.95,0.85,0.6))]
COVERS=[(0.45,0.08,0.06),(0.06,0.14,0.42),(0.07,0.30,0.12),(0.55,0.40,0.05),(0.30,0.10,0.35)]
_QM={}
def _qmat(rgb):
    k=tuple(round(c,3) for c in rgb)
    if k not in _QM:
        m=bpy.data.materials.new("Q_%02x%02x%02x"%tuple(int(c*255) for c in k)); m.use_nodes=True
        b=m.node_tree.nodes["Principled BSDF"]; b.inputs["Base Color"].default_value=(*k,1); b.inputs["Roughness"].default_value=0.75; _QM[k]=m
    return _QM[k]
def _recolor(obj):
    """Quaternius ships its colours only inside .blend files (OBJ/MTL are flat grey); map slots by name onto shared materials."""
    for i,slot in enumerate(obj.material_slots):
        n=(slot.material.name if slot.material else "").lower(); rgb=(0.5,0.5,0.5)
        for key,col in QCOL:
            if key in n: rgb=col if col else COVERS[i%len(COVERS)]; break
        slot.material=_qmat(rgb)
def place(key,coll,x,y,z,rot_z=0.0,scale=1.0,name=None):
    src=LIB[key]["obj"]; o=src.copy(); o.data=src.data
    o.name=name or f"{coll.name}_{key}"; o.location=(x,y,z); o.rotation_euler=(0,0,rot_z); o.scale=(scale,scale,scale)
    coll.objects.link(o); return o

def _flat_mat(name, rgb_srgb):
    """Flat Principled material from an sRGB hex-style tuple (the districts' shading discipline)."""
    if name in bpy.data.materials: return bpy.data.materials[name]
    m = bpy.data.materials.new(name); m.use_nodes = True
    lin = tuple(((c + 0.055) / 1.055) ** 2.4 if c > 0.04045 else c / 12.92 for c in rgb_srgb)
    b = m.node_tree.nodes["Principled BSDF"]; b.inputs["Base Color"].default_value = (*lin, 1); b.inputs["Roughness"].default_value = 0.9
    return m

def tree_variants(asset_id, budget, variants, source="blendkit"):
    """Load a tree .blend once (decimated by load()), then register one LIB entry per
    (key, leaf_rgb, bark_rgb): each variant gets its own mesh copy whose material slots are
    replaced by flat materials — the source's procedural leaf shader does not survive glTF
    export, and flat colour is the districts' shading discipline anyway. Slot mapping is by
    material name: *leaf* -> foliage, *bark*/*trunk* -> bark, anything else -> bark."""
    base = load(asset_id, budget, source=source, name=f"_treebase_{budget}_{asset_id}")
    src = base["obj"]
    # Variants are stored as bare MESHES, never as scene objects: both export
    # paths select scene objects wholesale (mkit selects every object), so a
    # master object would ship as an unscaled tree at the district origin.
    # Placements instantiate fresh objects from the mesh (see instantiate()).
    for key, leaf_rgb, bark_rgb in variants:
        if key in LIB: continue
        me = src.data.copy(); me.name = f"LIB_{key}"; me.use_fake_user = True
        leaf = _flat_mat(f"flat_leaf_{key}", leaf_rgb); bark = _flat_mat(f"flat_bark_{key}", bark_rgb)
        for i, slot in enumerate(me.materials):
            n = (slot.name if slot else "").lower()
            me.materials[i] = leaf if "leaf" in n else bark
        LIB[key] = {"obj": None, "mesh": me, "dims": base["dims"], "tris_raw": base["tris_raw"], "tris": base["tris"], "source": source, "id": asset_id,
                    "credit": "https://www.blenderkit.com (asset b9082156-eca0-4d99-bfae-c5ea20462f9b)", "credit_license": "royalty_free (BlenderKit)"}
    # The base object itself must not reach any export either: it still wears
    # the source's (unexportable) procedural materials and would ship as a
    # white tree at the district origin. The variants hold their own meshes.
    bpy.data.objects.remove(base["obj"], do_unlink=True)
    return LIB

def instantiate(key, coll, x, y, z, rot_z=0.0, scale=1.0, name=None):
    """Place a fresh scene object from a mesh-only LIB entry (tree_variants)."""
    o = bpy.data.objects.new(name or f"{coll.name}_{key}", LIB[key]["mesh"])
    o.location = (x, y, z); o.rotation_euler = (0, 0, rot_z)
    o.scale = scale if isinstance(scale, tuple) else (scale, scale, scale)
    coll.objects.link(o); return o

# ---- Sketchfab tree pack: "Low Poly Forest Tree Pack" by 99.Miles, CC-BY 4.0 ----
# Kept local under assets/sketchfab/ (gitignored, like blendkit downloads); the
# download is a zip whose scene.gltf + scene.bin + textures/ land in the folder.
PACK_ID = "low-poly-forest-tree-pack"
PACK_CREDIT = "https://sketchfab.com/3d-models/low-poly-forest-tree-pack-5ff5a51e74324845a4e4905f182dfb2b"
PACK_LICENSE = "CC-BY 4.0"
_PACK_MODELS = None

def _base_image(m):
    """The image feeding a Principled material's Base Color, or None."""
    if not m or not m.use_nodes: return None
    b = next((n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not b: return None
    src = next((l.from_node for l in m.node_tree.links if l.to_node == b and l.to_socket.name == 'Base Color'), None)
    while src and src.type != 'TEX_IMAGE':
        ins = [x for x in src.inputs if x.is_linked]; src = ins[0].links[0].from_node if ins else None
    return src.image if src else None

def _diffuse_mat(m):
    """Material-level _diffuse_only: drop normal/roughness/metallic feeds, constant roughness."""
    if not m or not m.use_nodes: return
    nt = m.node_tree; b = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
    if not b: return
    for l in list(nt.links):
        if l.to_node == b and l.to_socket.name in ('Normal', 'Roughness', 'Metallic'): nt.links.remove(l)
    for n in list(nt.nodes):
        if n.type == 'NORMAL_MAP': nt.nodes.remove(n)
    b.inputs['Roughness'].default_value = 0.85; b.inputs['Metallic'].default_value = 0.0

def _pack_models(tex):
    """Split the pack glTF into {model: (mesh, dims, tris, roles)} — origin at bottom
    centre, world transforms baked. Models: 4 hero trees (trunk+branches pairs,
    grouped by nearest XZ centre) named by form (hero_tall/hero_full/hero_stocky/
    hero_slim) + the tall single-mesh atlas trees bg_a..bg_h. Rocks and the pack's
    small shrub meshes are skipped — the districts keep their own shrubs."""
    global _PACK_MODELS
    if _PACK_MODELS is not None: return _PACK_MODELS
    import json as _json, re as _re
    src = _json.load(open(os.path.join(HERE, "assets", "sketchfab", PACK_ID, "scene.gltf")))
    foliage = {mt.get("name") for mt in src.get("materials", []) if mt.get("alphaMode") == "BLEND"}
    before = set(bpy.data.objects); imgs_before = set(bpy.data.images)
    bpy.ops.import_scene.gltf(filepath=os.path.join(HERE, "assets", "sketchfab", PACK_ID, "scene.gltf"))
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    # canonical material per base-colour image (the FBX->glTF split duplicates
    # materials per part instance; they share textures, so unify before stripping)
    canon = {}
    for o in meshes:
        for i, slot in enumerate(o.data.materials):
            img = _base_image(slot); k = img.name if img else (slot.name if slot else None)
            if k in canon: o.data.materials[i] = canon[k]
            elif slot: canon[k] = slot
    for m in set(canon.values()):
        _diffuse_mat(m)
        if _re.sub(r"\.\d{3}$", "", m.name) in foliage:
            # foliage alpha cards: route texture alpha through Math ROUND into the
            # Principled Alpha socket — the pattern the glTF exporter turns into
            # alphaMode MASK, cutoff 0.5 (halo.py's palm discipline; the material
            # blend/render-method switches alone still export as BLEND on 5.2)
            nt = m.node_tree; b = next((n for n in nt.nodes if n.type == 'BSDF_PRINCIPLED'), None)
            link = next((l for l in nt.links if l.to_node == b and l.to_socket.name == 'Alpha'), None)
            texnode = next((n for n in nt.nodes if n.type == 'TEX_IMAGE' and n.image is _base_image(m)), None)
            if b and texnode:
                rnd = nt.nodes.new("ShaderNodeMath"); rnd.operation = "ROUND"
                if link: nt.links.remove(link)
                nt.links.new(texnode.outputs["Alpha"], rnd.inputs[0]); nt.links.new(rnd.outputs[0], b.inputs["Alpha"])
    for img in set(bpy.data.images) - imgs_before:
        if img.size[0] > tex: img.scale(tex, max(1, int(img.size[1] * tex / img.size[0])))
    def wb(o):
        bb = [o.matrix_world @ Vector(c) for c in o.bound_box]
        mn = Vector([min(v[i] for v in bb) for i in range(3)]); mx = Vector([max(v[i] for v in bb) for i in range(3)])
        return mn, mx
    info = {}
    for o in meshes:
        mn, mx = wb(o); info[o.name] = (o, mn, mx, (mn + mx) / 2)
    groups = {}   # model -> [objects]
    trunks = [n for n in info if n.startswith("Tree_Trunk")]; branches = [n for n in info if n.startswith("Tree_Branches")]
    for tn in trunks:
        tc = info[tn][3]
        bn = min(branches, key=lambda b: (info[b][3].x - tc.x) ** 2 + (info[b][3].y - tc.y) ** 2)
        assert (info[bn][3].x - tc.x) ** 2 + (info[bn][3].y - tc.y) ** 2 < 6.25, f"no branch near {tn}"
        groups.setdefault(f"hero@{tn}", []).extend([info[tn][0], info[bn][0]]); branches.remove(bn)
    bgs = sorted((n for n in info if n.startswith("Background_Tree_Atlas") and (info[n][2].z - info[n][1].z) >= 10), key=lambda n: info[n][3].x)
    for i, n in enumerate(bgs): groups[f"bg_{chr(97 + i)}"] = [info[n][0]]
    models = {}
    for gname, objs in groups.items():
        for o in objs: o.data.transform(o.matrix_world); o.matrix_world = __import__('mathutils').Matrix.Identity(4)
        for o in bpy.context.selected_objects: o.select_set(False)
        for o in objs: o.select_set(True)
        bpy.context.view_layer.objects.active = objs[0]
        if len(objs) > 1: bpy.ops.object.join()
        obj = bpy.context.view_layer.objects.active
        vs = [v.co for v in obj.data.vertices]
        mn = Vector([min(v[i] for v in vs) for i in range(3)]); mx = Vector([max(v[i] for v in vs) for i in range(3)])
        off = Vector(((mn.x + mx.x) / 2, (mn.y + mx.y) / 2, mn.z))
        for v in obj.data.vertices: v.co -= off
        me = obj.data; tris = sum(len(p.vertices) - 2 for p in me.polygons)
        roles = ["trunk" if "trunk" in ((_base_image(mt).name if _base_image(mt) else (mt.name if mt else "")).lower()) else "leaf" for mt in me.materials]
        if gname.startswith("hero@"):
            h = mx.z - mn.z
            key = "hero_tall" if h >= 22 else "hero_full" if h >= 15 else "hero_birch" if tris <= 300 else "hero_stocky"
        else: key = gname
        me.name = f"LIB_{key}"; me.use_fake_user = True
        models[key] = (me, tuple(round(d, 3) for d in (mx - mn)), tris, roles)
        bpy.data.objects.remove(obj, do_unlink=True)
    for o in list(bpy.data.objects):     # rocks, shrubs, empties, pair leftovers — nothing stray ships
        if o not in before: bpy.data.objects.remove(o, do_unlink=True)
    _PACK_MODELS = models
    return models

def tree_variants_sketchfab(variants, tex=TEX):
    """Register one LIB entry per (key, model, skin) from the Sketchfab tree pack.
    skin=None keeps the pack's own materials — downsized to tex px, diffuse-only,
    foliage alpha converted from blend to cutout (the Halo palm discipline).
    skin=(leaf_rgb, bark_rgb) flat-re-skins by slot role instead. Mesh-only
    entries, placed via instantiate(), same as tree_variants."""
    models = _pack_models(tex)
    for key, model, skin in variants:
        if key in LIB: continue
        me, dims, tris, roles = models[model]
        if skin is None: out = me
        else:
            out = me.copy(); out.name = f"LIB_{key}"; out.use_fake_user = True
            leaf = _flat_mat(f"flat_leaf_{key}", skin[0]); bark = _flat_mat(f"flat_bark_{key}", skin[1])
            for i, role in enumerate(roles): out.materials[i] = bark if role == "trunk" else leaf
        LIB[key] = {"obj": None, "mesh": out, "dims": dims, "tris_raw": tris, "tris": tris, "source": "sketchfab", "id": PACK_ID,
                    "credit": PACK_CREDIT, "credit_license": PACK_LICENSE}
    return LIB
