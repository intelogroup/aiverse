"""Build plaza masonry and bronze fountain fixtures in world coordinates, in metres.

Run via blender_lock.sh -b --factory-startup --python fountain_architecture.py -- OUTPUT.glb.
"""
import json
import math
from pathlib import Path
import sys

import bmesh
import bpy
from mathutils import Vector

here = Path(__file__).resolve().parent
assets = here.parents[1] / "apps/console/public/assets"
design = json.loads((assets / "city3-fountain.json").read_text())
output = Path(sys.argv[sys.argv.index("--") + 1])
bpy.ops.object.select_all(action="SELECT")
bpy.ops.object.delete()


def material(name, color, roughness, metalness=0):
    mat = bpy.data.materials.new(name)
    mat.diffuse_color = (*color, 1)
    mat.use_nodes = True
    shader = mat.node_tree.nodes["Principled BSDF"]
    shader.inputs["Base Color"].default_value = mat.diffuse_color
    shader.inputs["Roughness"].default_value = roughness
    shader.inputs["Metallic"].default_value = metalness
    return mat


def mapped_stone(name, directory, stem, roughness, normal_strength):
    mat = material(name, (.65, .58, .46), roughness)
    nodes = mat.node_tree
    shader = nodes.nodes["Principled BSDF"]
    diffuse = nodes.nodes.new("ShaderNodeTexImage")
    diffuse.image = bpy.data.images.load(str(directory / f"{stem}_c.jpg"))
    nodes.links.new(diffuse.outputs["Color"], shader.inputs["Base Color"])
    normal_image = nodes.nodes.new("ShaderNodeTexImage")
    normal_image.image = bpy.data.images.load(str(directory / f"{stem}_n.jpg"))
    normal_image.image.colorspace_settings.name = "Non-Color"
    normal = nodes.nodes.new("ShaderNodeNormalMap")
    normal.inputs["Strength"].default_value = normal_strength
    nodes.links.new(normal_image.outputs["Color"], normal.inputs["Color"])
    nodes.links.new(normal.outputs["Normal"], shader.inputs["Normal"])
    return mat


stone = mapped_stone("Fountain cut limestone", here / "assets/bazaar-facades",
                     "white_plaster_02", .68, .42)
pavers = mapped_stone("Clock island stone mosaic", here / "assets/tea-floors",
                      "marble_mosaic_tiles", .84, .38)
mortar = material("Fountain recessed limestone joints", (.64, .55, .42), .83)
bronze = material("Fountain aged bronze", (.25, .128, .059), .36, .72)
lip = material("Fountain burnished bronze", (.45, .243, .08), .26, .75)
throat = material("Fountain nozzle interior", (.037, .025, .015), .53, .55)

count = design["segments"]
step = math.tau / count
inner = design["innerRadius"] + .05
outer = design["outerRadius"] - .05
rim = design["waterY"] + .30
base = design["waterY"] - .60


def on_collision_polygon(radius, angle):
    """Match the underlying 32-sided collision rim, including across the chords."""
    relative = (angle % step) - step / 2
    return radius * math.cos(step / 2) / math.cos(relative)


def ring_strip(name, profile, angle0, angle1, steps, mat, point, loop=False, smooth=False):
    width = len(profile)
    samples = steps if loop else steps + 1
    vertices = []
    for i in range(samples):
        angle = angle0 + (angle1 - angle0) * i / steps
        vertices.extend(point(radius, height, angle) for radius, height in profile)
    faces = []
    for i in range(steps):
        a, b = i * width, ((i + 1) % samples) * width
        for j in range(width):
            k = (j + 1) % width
            faces.append((a + j, b + j, b + k, a + k))
    if not loop:
        faces.extend((tuple(reversed(range(width))), tuple(range(steps * width, samples * width))))
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    bm = bmesh.new()
    bm.from_mesh(mesh)
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    assert all(edge.is_manifold for edge in bm.edges), name
    assert bm.calc_volume() > 0, name
    bm.to_mesh(mesh)
    bm.free()
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.collection.objects.link(obj)
    mesh.materials.append(mat)
    if mat in (stone, mortar, pavers):
        uv = mesh.uv_layers.new()
        for poly in mesh.polygons:
            bearing = math.atan2(poly.center.y, poly.center.x)
            for index in poly.loop_indices:
                x, y, z = mesh.vertices[mesh.loops[index].vertex_index].co
                # Unwrap about the face so the negative-X seam cannot smear the stone.
                angle = bearing + (math.atan2(y, x) - bearing + math.pi) % math.tau - math.pi
                uv.data[index].uv = (x * 1.5, y * 1.5) if abs(poly.normal.z) > .6 else (
                    angle * math.hypot(x, y) * 1.5, z * 1.5)
    for face in mesh.polygons:
        face.use_smooth = smooth
    return obj


def masonry_point(radius, z, angle):
    radial = on_collision_polygon(radius, angle)
    return radial * math.cos(angle), radial * math.sin(angle), z


def masonry(name, sides, cap):
    a, b = sides
    # The base masks the legacy wall and coping beneath the new cut-stone sectors.
    face_radius = b - .026 if name == "Outer" else b
    wall = [(a + .028, base - .035), (face_radius - .024, base - .035),
            (face_radius, base + .12), (face_radius, rim + .002), (b, rim + .016),
            (a, rim + .016), (a, base + .10)]
    ring_strip(f"{name} continuous masonry", wall, 0, math.tau, count, mortar, masonry_point, loop=True)
    start, end = cap
    top = rim + .075
    bottom = rim + .011
    profile = [(start, bottom), (end, bottom), (end, top - .021), (end - .019, top),
               (start + .018, top), (start, top - .018)]
    gap = .006 / ((start + end) / 2)
    for i in range(count):
        ring_strip(f"{name} coping {i + 1:02d}", profile,
                   i * step + gap, (i + 1) * step - gap, 1, stone, masonry_point)


masonry("Outer", (outer - .16, outer + .50), (outer - .16, outer + .50))
masonry("Island", (inner - .50, inner), (inner - .50, inner))

# Match the island's collision elevation. Tuck the mosaic under its coping and
# run it underneath the plinth so the scan's broad foot cannot show through.
deck = [(.32, rim - .035), (inner - .43, rim - .035),
        (inner - .43, rim + .025), (.32, rim + .025)]
ring_strip("Clock island mosaic paving", deck, 0, math.tau, count, pavers, masonry_point, loop=True)


# A broad plinth course and a taller face course share the existing outer chord.
outer_face = outer + .50
for course, (low, high, face) in enumerate([
    (base - .009, base + .18, outer_face),
    (base + .189, rim - .021, outer_face - .009),
]):
    back = outer_face - .034
    profile = [(back, low), (face - .007, low), (face, low + .008),
               (face, high - .009), (face - .008, high), (back, high)]
    gap = .0045 / outer_face
    for i in range(count):
        ring_strip(f"Outer course {course + 1} stone {i + 1:02d}", profile,
                   i * step + gap, (i + 1) * step - gap, 1, stone, masonry_point)

# The scan is slightly off center. Fit an octagon to the eight measured
# support planes of its exposed foot, with a margin for the stone drip edge.
supports = (3.29, 3.70, 3.15, 3.50, 2.96, 3.41, 3.04, 3.54)
directions = [(math.cos(i * math.tau / 8), math.sin(i * math.tau / 8)) for i in range(8)]
corners = []
for i, (nx, ny) in enumerate(directions):
    j = (i + 1) % 8
    mx, my = directions[j]
    det = nx * my - ny * mx
    corners.append(((supports[i] * my - ny * supports[j]) / det,
                    (nx * supports[j] - supports[i] * mx) / det))


def plinth_point(scale, height, angle):
    x, y = corners[round(angle * 8 / math.tau) % 8]
    return x * scale, y * scale, height


plinth_section = [(.33, rim - .018), (.977, rim - .018), (.993, rim + .018),
                  (.993, rim + .148), (1.0, rim + .169), (1.0, rim + .199),
                  (.986, rim + .236), (.33, rim + .236)]
plinth = ring_strip("Clock tower cut-stone plinth", plinth_section, 0, math.tau, 8,
                   stone, plinth_point, loop=True)
# The visible stone remains at least a metre inside the island coping.
plinth_radius = max(math.hypot(v.co.x, v.co.y) for v in plinth.data.vertices)
coping_inside = on_collision_polygon(inner - .50, step / 2)
assert coping_inside - plinth_radius >= 1.0
print(f"Plinth clearance to the island coping: at least {coping_inside - plinth_radius:.2f} m")


reach = design["jetRange"]
flight = design["jetFlightTime"]
jet_radius = design["jetRadius"]
jet_y = design["jetY"]
pitch = (design["waterY"] + .015 - jet_y + .5 * 9.81 * flight ** 2) / reach

for i in range(design["jetCount"]):
    angle = i * math.tau / design["jetCount"] + design["jetAngleOffset"]
    radial = Vector((math.cos(angle), math.sin(angle), 0))
    lateral = Vector((-radial.y, radial.x, 0))
    axis = (radial + Vector((0, 0, pitch))).normalized()
    up = axis.cross(lateral)
    outlet = jet_radius * radial + Vector((0, 0, jet_y))

    def upright(radius, height, theta):
        return jet_radius * radial + Vector((radius * math.cos(theta), radius * math.sin(theta), height))

    foot = [(0.04, base), (.215, base), (.223, base + .035), (.223, base + .16),
            (.18, base + .21), (.145, base + .28), (.115, jet_y - .43),
            (.16, jet_y - .25), (.213, jet_y - .194), (.213, jet_y - .094),
            (.18, jet_y - .075), (.04, jet_y - .075)]
    ring_strip(f"Bronze pedestal {i + 1}", foot, 0, math.tau, 24, bronze, upright, loop=True, smooth=True)

    def spout(radius, length, theta):
        return outlet + length * axis + radius * (math.cos(theta) * lateral + math.sin(theta) * up)

    pipe = [(.037, -.32), (.095, -.32), (.11, -.28), (.09, -.22), (.06, -.09),
            (.071, -.03), (.065, -.014), (.04, -.014)]
    mouth = [(.04, -.025), (.068, -.025), (.075, -.017), (.075, -.008),
             (.069, 0), (.039, 0), (.034, -.008)]
    ring_strip(f"Bronze nozzle {i + 1}", pipe, 0, math.tau, 20, bronze, spout, loop=True, smooth=True)
    ring_strip(f"Nozzle lip {i + 1}", mouth, 0, math.tau, 20, lip, spout, loop=True, smooth=True)
    ring_strip(f"Nozzle bore {i + 1}", [(.006, -.11), (.039, -.11), (.039, -.007), (.034, -.007)],
               0, math.tau, 20, throat, spout, loop=True, smooth=True)

# Join the assembly into one mesh, split by material at export.
bpy.ops.object.select_all(action="SELECT")
bpy.context.view_layer.objects.active = bpy.context.selected_objects[0]
bpy.ops.object.join()
assembly = bpy.context.object
assembly.name = "City3FountainMasonryAndSpouts"
for vertex in assembly.data.vertices:
    x, y, _ = vertex.co
    limit = on_collision_polygon(outer + .50, math.atan2(y, x))
    assert math.hypot(x, y) <= limit + .00001, (vertex.index, limit)
assert jet_radius + reach + .21 * (.25 + 2.2) < on_collision_polygon(outer - .16, step / 2)
assert output.parent.is_dir(), output.parent
bpy.ops.export_scene.gltf(filepath=str(output), export_format="GLB")
print(f"Fountain assembly: {len(assembly.data.polygons)} faces, {output.stat().st_size} bytes")
