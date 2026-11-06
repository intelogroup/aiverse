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
def load(asset_id,budget,source="polyhaven",name=None):
    key=name or asset_id
    if key in LIB: return LIB[key]
    before=set(bpy.data.objects); imgs_before=set(bpy.data.images)
    if source=="polyhaven": bpy.ops.import_scene.gltf(filepath=os.path.join(PH,asset_id,f"{asset_id}_1k.gltf"))
    else: bpy.ops.import_scene.fbx(filepath=os.path.join(QT,f"{asset_id}.fbx"))
    new=[o for o in bpy.data.objects if o not in before]
    new_names=[o.name for o in new]
    meshes=[o for o in new if o.type=="MESH"]
    for o in bpy.context.selected_objects: o.select_set(False)
    for o in meshes: o.select_set(True)
    bpy.context.view_layer.objects.active=meshes[0]
    if len(meshes)>1: bpy.ops.object.join()
    obj=bpy.context.view_layer.objects.active
    obj.parent=None
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
    for img in set(bpy.data.images)-imgs_before:
        if img.size[0]>TEX: img.scale(TEX,max(1,int(img.size[1]*TEX/img.size[0])))
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
