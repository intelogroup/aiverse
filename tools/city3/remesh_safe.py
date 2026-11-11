"""Robust Quadriflow wrapper for headless Blender.

Quadriflow rejects meshes that are non-manifold, have inconsistent normals, or
are made of thin/degenerate shells. Per shell: clean, try Quadriflow, and fall
back to a voxel remesh (always watertight quads) when it refuses.

Run: Blender -b --python tools/city3/remesh_safe.py -- IN.glb OUT.glb [ratio]
Use remesh_object(obj, ratio) from other scripts.
"""
import sys
import bmesh
import bpy


def _clean(o):
    bm = bmesh.new()
    bm.from_mesh(o.data)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    bmesh.ops.dissolve_degenerate(bm, dist=1e-5, edges=bm.edges)
    # drop wire edges / loose verts
    bmesh.ops.delete(bm, geom=[e for e in bm.edges if not e.link_faces], context="EDGES")
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_edges], context="VERTS")
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bm.to_mesh(o.data)
    bm.free()
    o.data.update()


def _sel(o):
    bpy.ops.object.select_all(action="DESELECT")
    o.select_set(True)
    bpy.context.view_layer.objects.active = o


def _voxel(o, size):
    o.data.remesh_voxel_size = size
    o.data.remesh_voxel_adaptivity = 0.0
    bpy.ops.object.voxel_remesh()


def remesh_object(o, ratio=0.1, min_faces=50):
    """Remesh one mesh object in place. Returns 'quadriflow' | 'voxel' | 'skipped'."""
    _sel(o)
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    _clean(o)
    n0 = len(o.data.polygons)
    if n0 == 0:
        return "skipped"
    target = max(min_faces, int(n0 * ratio))
    # 1) direct
    try:
        if "FINISHED" in bpy.ops.object.quadriflow_remesh(target_faces=target, mode="FACES", seed=0):
            return "quadriflow"
    except RuntimeError:
        pass
    # 2) watertight via voxel, then quadriflow again
    backup = o.data.copy()
    size = max(o.dimensions) / 80 or 0.01
    for s in (size, size * 0.5):
        _voxel(o, s)
        _clean(o)
        try:
            if "FINISHED" in bpy.ops.object.quadriflow_remesh(target_faces=target, mode="FACES", seed=0):
                bpy.data.meshes.remove(backup)
                return "quadriflow"
        except RuntimeError:
            pass
        o.data = backup.copy()
    # 3) voxel result is the answer
    o.data = backup
    _voxel(o, size)
    return "voxel"


def main():
    argv = sys.argv[sys.argv.index("--") + 1:]
    src, dst = argv[0], argv[1]
    ratio = float(argv[2]) if len(argv) > 2 else 0.1
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=src)
    for o in [o for o in bpy.context.scene.objects if o.type == "MESH"]:
        n0 = len(o.data.polygons)
        how = remesh_object(o, ratio)
        print(f"REMESH {o.name}: {n0} -> {len(o.data.polygons)} via {how}")
    bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB")


if __name__ == "__main__":
    main()
