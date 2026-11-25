"""Bake the Market Hall's repeatable oak-and-steel stall modules with Blender.

Run through blender_lock.sh. The layout, collision, and existing library
props are assembled separately by market_hall_room.mjs.
"""
import math
import random
import sys

import bpy
from mathutils import Vector

bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, roughness=0.6, metallic=0):
    m = bpy.data.materials.new(name)
    m.diffuse_color = (*color, 1)
    m.use_nodes = True
    bsdf = m.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = (*color, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    return m


steel = material("Charcoal powder coat", (0.065, 0.073, 0.069), 0.42, 0.35)
oak = material("Oiled oak", (0.42, 0.238, 0.116))
oak_light = material("Oak end grain", (0.51, 0.304, 0.151))
stone = material("Cream terrazzo", (0.56, 0.52, 0.43), 0.38)
floor_stone = material("Warm honed market stone", (0.23, 0.195, 0.155), 0.72)
green = material("Deep green enamel", (0.054, 0.224, 0.153), 0.38)
screen = material("Checkout touch display", (0.15, 0.37, 0.35), 0.27)
bread = material("Golden crust", (0.52, 0.23, 0.067))
flour = material("Pale scoring", (0.76, 0.53, 0.26))
paper = material("Ivory paper labels", (0.72, 0.63, 0.49))
cheese = material("Golden cheese", (0.79, 0.51, 0.17))
rind = material("Terracotta cheese rind", (0.41, 0.105, 0.047))
leaf = material("Flower foliage", (0.095, 0.25, 0.078))
petals = [
    material("Dahlia coral", (0.57, 0.085, 0.105)),
    material("Daisy cream", (0.79, 0.65, 0.31)),
    material("Aster violet", (0.28, 0.15, 0.43)),
]
opal = material("Warm opal glass", (0.95, 0.72, 0.43), 0.26)
bulb = opal.node_tree.nodes.get("Principled BSDF")
bulb.inputs["Emission Color"].default_value = (1, 0.66, 0.32, 1)
bulb.inputs["Emission Strength"].default_value = 0.85
produce = [material(name, color) for name, color in [
    ("Red apples", (0.58, 0.049, 0.027)), ("Pears", (0.38, 0.47, 0.09)),
    ("Oranges", (0.79, 0.262, 0.024)), ("Lemons", (0.78, 0.6, 0.05)),
    ("Green apples", (0.17, 0.37, 0.081)), ("Purple plums", (0.26, 0.075, 0.14)),
]]


def asset(name):
    obj = bpy.data.objects.new(f"LIB_{name}", None)
    bpy.context.collection.objects.link(obj)
    return obj


def piece(root, mesh, appearance):
    obj = bpy.context.object
    obj.name = mesh
    obj.parent = root
    obj.data.materials.append(appearance)
    return obj


def block(root, name, pos, size, appearance, bevel=0.008):
    bpy.ops.mesh.primitive_cube_add(size=1, location=pos)
    obj = piece(root, name, appearance)
    obj.dimensions = size
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    if bevel:
        edge = obj.modifiers.new("Eased edges", "BEVEL")
        edge.width, edge.segments = bevel, 2
        obj.modifiers.new("Face normals", "WEIGHTED_NORMAL")
    return obj


def oval(root, name, pos, size, appearance):
    bpy.ops.mesh.primitive_uv_sphere_add(segments=12, ring_count=8, radius=1, location=pos)
    obj = piece(root, name, appearance)
    obj.scale = size
    for face in obj.data.polygons:
        face.use_smooth = True
    return obj


def cylinder(root, name, pos, radius, height, appearance, vertices=16):
    bpy.ops.mesh.primitive_cylinder_add(vertices=vertices, radius=radius, depth=height, location=pos)
    return piece(root, name, appearance)


def beam(root, name, start, end, width):
    a, b = Vector(start), Vector(end)
    direction = b - a
    obj = block(root, name, (a+b)/2, (width,width,direction.length+0.02), steel)
    obj.rotation_euler = direction.to_track_quat("Z", "Y").to_euler()


def sign(root, label, y, z, width):
    block(root, "Sign backing", (0,y,z), (width,0.055,0.235), steel)
    bpy.ops.object.text_add(location=(0,y-0.031,z), rotation=(math.pi/2,0,0))
    obj = bpy.context.object
    obj.data.body = label
    obj.data.align_x = "CENTER"
    obj.data.align_y = "CENTER"
    obj.data.size = 0.145
    bpy.ops.object.convert(target="MESH")
    piece(root, label, opal)


def legs(root, w, d, h):
    for x in (-w/2+0.08, w/2-0.08):
        for y in (-d/2+0.08, d/2-0.08):
            block(root, "Steel leg", (x,y,h/2), (0.06,0.06,h), steel)


def table(root, w, d, h, surface):
    legs(root, w, d, h-0.055)
    block(root, "Tabletop", (0,0,h-0.0275), (w,d,0.055), surface)


def counter(root, w, d, h, panel):
    legs(root, w, d, h-0.055)
    block(root, "Cabinet", (0,0,h/2+0.025), (w-0.08,d-0.08,h-0.15), panel)
    block(root, "Worktop", (0,0,h-0.0275), (w,d,0.055), stone)
    for x in range(math.floor((-w/2+0.10)*8), math.ceil((w/2-0.10)*8)):
        block(root, "Oak face slat", (x/8,-d/2+0.026,h/2+0.025), (0.038,0.026,h-0.18), oak)


def tray(root, x, y, base, w, d):
    block(root, "Tray bottom", (x,y,base+0.018), (w,d,0.036), oak)
    for side in (-1, 1):
        block(root, "Tray end", (x+side*(w-0.035)/2,y,base+0.07), (0.035,d,0.12), oak_light)
        block(root, "Tray rail", (x,y+side*(d-0.035)/2,base+0.07), (w-0.07,0.035,0.12), oak)


def produce_display():
    root = asset("hall_produce")
    table(root, 2.8, 1.5, 0.88, oak)
    rng = random.Random(410)
    for i, appearance in enumerate(produce):
        x, y = (i%3-1)*0.88, (i//3-0.5)*0.68
        tray(root, x, y, 0.88, 0.84, 0.63)
        for ix in range(5):
            for iy in range(3):
                s = rng.uniform(0.054, 0.072)
                oval(root, appearance.name, (x+(ix-2)*0.145,y+(iy-1)*0.156,0.92+s), (s,s,0.97*s), appearance)


def bread_display(root, w, base, *, center=True):
    positions = (-w*0.32, 0, w*0.32) if center else (-w*0.32, w*0.32)
    for x in positions:
        tray(root, x, 0, base, min(0.73,w*0.27), 0.58)
        for y in (-0.145, 0.11):
            for dx in (-0.16,0.16):
                oval(root, "Bread roll", (x+dx,y,base+0.085), (0.11,0.085,0.055), bread)
                oval(root, "Roll scoring", (x+dx,y,base+0.137), (0.062,0.012,0.005), flour)


produce_display()
bakery = asset("hall_bakery")
counter(bakery, 4.2, 1.0, 1.04, oak)
bread_display(bakery, 4.2, 1.04)
for x in (-2.02, 2.02):
    block(bakery, "Stall upright", (x,0.40,1.02), (0.06,0.06,2.04), steel)
block(bakery, "Stall crossbar", (0,0.40,2.01), (4.1,0.06,0.06), steel)
sign(bakery, "BAKERY", 0.40, 1.90, 1.25)

pantry = asset("hall_pantry")
counter(pantry, 4.2, 1.0, 1.04, oak)
for z in (1.05, 1.54):
    block(pantry, "Pantry shelf", (0,0.1,z), (3.9,0.7,0.05), oak)
    for i in range(12):
        x = -1.68+i*0.30
        block(pantry, "Wrapped stock", (x,0.04,z+0.145), (0.18,0.25,0.24), produce[i%len(produce)])
for x in (-2.02, 2.02):
    block(pantry, "Display steel post", (x,0.40,1.02), (0.06,0.06,2.04), steel)
block(pantry, "Stall crossbar", (0,0.40,2.01), (4.1,0.06,0.06), steel)
sign(pantry, "PANTRY", 0.40, 1.90, 1.25)

gondola = asset("hall_shelf")
for x in (-1.28, 1.28):
    for y in (-0.4, 0.4):
        block(gondola, "Shelf upright", (x,y,0.78), (0.055,0.055,1.56), steel)
block(gondola, "Shelf divider", (0,0,0.83), (2.55,0.06,1.39), oak)
for tier, z in enumerate((0.25,0.73,1.18)):
    block(gondola, "Stock shelf", (0,0,z), (2.7,0.94,0.055), oak)
    for side in (-1, 1):
        y = side*0.24
        block(gondola, "Shelf-edge label rail", (0,side*0.465,z+0.033), (2.65,0.022,0.036), steel)
        for i in range(10):
            x = (i-4.5)*0.235
            color = produce[(i//2+tier*2)%len(produce)]
            if tier == 1:
                cylinder(gondola, "Pantry jar", (x,y,z+0.124), 0.066, 0.192, color, 12)
                cylinder(gondola, "Jar lid", (x,y,z+0.229), 0.071, 0.018, steel, 12)
                cylinder(gondola, "Jar paper band", (x,y,z+0.117), 0.067, 0.066, paper, 12)
            else:
                height = 0.25 if tier == 0 else 0.18
                block(gondola, "Paper carton", (x,y,z+0.029+height/2), (0.157,0.17,height), color)
                block(gondola, "Carton label", (x,y+side*0.086,z+0.045+height/2), (0.10,0.004,0.063), paper, bevel=0)

dairy = asset("hall_cheese")
counter(dairy, 3.5, 0.96, 1.04, green)
for x in (-1.08,-0.32,0.41,1.09):
    tray(dairy, x, 0, 1.04, 0.63, 0.62)
    cylinder(dairy, "Washed rind", (x,0.07,1.1545), 0.196, 0.157, rind, 24)
    cylinder(dairy, "Cheese cut face", (x,0.07,1.237), 0.188, 0.01, cheese, 24)
    wedge = cylinder(dairy, "Cheese sample wedge", (x,-0.17,1.1185), 0.103, 0.085, cheese, 3)
    wedge.rotation_euler.z = x
for x in (-1.62, 1.62):
    block(dairy, "Counter sign post", (x,0.36,1.46), (0.065,0.065,0.84), steel)
block(dairy, "Counter sign rail", (0,0.36,1.85), (3.25,0.06,0.06), steel)
sign(dairy, "CHEESE", 0.36, 1.78, 1.15)

flowers = asset("hall_flowers")
table(flowers, 3.4, 1.12, 0.83, oak)
for i in range(6):
    x = (i%3-1)*0.87 + (0.14 if i>=3 else -0.14)
    y = 0.25 if i>=3 else -0.25
    cylinder(flowers, "Flower bucket", (x,y,0.965), 0.14, 0.27, green, 16)
    for j in range(5):
        angle = j*math.tau/5 + i*0.61
        dx, dy = math.cos(angle)*0.13, math.sin(angle)*0.13
        head = 1.43+0.045*((i+j)%3)
        stem = cylinder(flowers, "Flower stem", (x+dx/2,y+dy/2,(1.09+head)/2), 0.012,
                        math.sqrt(dx*dx+dy*dy+(head-1.09)**2), leaf, 8)
        stem.rotation_euler = Vector((dx,dy,head-1.09)).to_track_quat("Z","Y").to_euler()
        oval(flowers, "Flower center", (x+dx,y+dy,head+0.012), (0.024,0.024,0.017), cheese)
        for k in range(6):
            petal_angle = k*math.tau/6 + angle
            petal = oval(
                flowers, "Flower petal",
                (x+dx+math.cos(petal_angle)*0.042,y+dy+math.sin(petal_angle)*0.042,head),
                (0.037,0.019,0.012), petals[i%3],
            )
            petal.rotation_euler.z = petal_angle
        blade = oval(flowers, "Stem leaf", (x+dx*0.57,y+dy*0.57,head-0.125), (0.061,0.019,0.008), leaf)
        blade.rotation_euler = (0,-0.55,angle+0.5)
for x in (-1.56, 1.56):
    block(flowers, "Counter sign post", (x,0.43,1.36), (0.065,0.065,1.06), steel)
block(flowers, "Counter sign rail", (0,0.43,1.85), (3.15,0.06,0.06), steel)
sign(flowers, "FLOWERS", 0.43, 1.78, 1.22)

snack = asset("hall_snack")
counter(snack, 3.6, 0.9, 1.04, green)
bread_display(snack, 2.6, 1.04, center=False)

checkout = asset("hall_checkout")
counter(checkout, 2.15, 0.9, 0.97, green)
block(checkout, "Scanner glass", (-0.43,0,0.979), (0.26,0.24,0.018), steel)
block(checkout, "Terminal foot", (0.48,0.12,0.989), (0.23,0.18,0.038), steel)
block(checkout, "Terminal stem", (0.48,0.16,1.085), (0.06,0.06,0.16), steel)
monitor = block(checkout, "Terminal housing", (0.48,0.14,1.21), (0.30,0.035,0.22), steel)
display = block(checkout, "Terminal screen", (0.48,0.120,1.213), (0.26,0.006,0.18), screen)
for obj in (monitor, display):
    obj.rotation_euler.x = math.radians(-12)

water = asset("hall_water")
counter(water, 1.06, 0.68, 0.96, green)
block(water, "Basin inset", (0,-0.08,0.962), (0.42,0.31,0.018), steel)
beam(water, "Tap riser", (0,0.14,0.958), (0,0.14,1.18), 0.045)
beam(water, "Tap spout", (0,0.14,1.18), (0,-0.04,1.18), 0.04)
block(water, "Sign support", (0,0.28,1.2), (0.055,0.055,0.48), steel)
sign(water, "WATER", 0.28, 1.33, 0.65)

sample = asset("hall_sample")
block(sample, "Sample plate", (0,0,0.016), (0.28,0.22,0.032), stone)
oval(sample, "Wrapped bakery sample", (0,0,0.067), (0.09,0.072,0.035), bread)
oval(sample, "Roll scoring", (0,0,0.101), (0.051,0.012,0.006), flour)

table(asset("hall_shared_table"), 3, 1.2, 0.78, oak)
table(asset("hall_bench"), 2.75, 0.36, 0.46, oak_light)

floor = asset("hall_floor")
block(floor, "Honed market floor", (0,0,-0.035), (36.5,41.5,0.07), floor_stone, bevel=0)

frame = asset("hall_roof_frame")
# Measured clear of the raised roof bays in the center of the raised clerestory.
for x in (-7, 7):
    block(frame, "Column foot", (x,0,0.045), (0.64,0.64,0.09), steel)
    beam(frame, "Steel column", (x,0,0.09), (x,0,9.35), 0.23)
beam(frame, "Lower chord", (-7,0,9.32), (7,0,9.32), 0.18)
beam(frame, "Rising chord", (-7,0,9.32), (0,0,10.65), 0.17)
beam(frame, "Falling chord", (0,0,10.65), (7,0,9.32), 0.17)
for x in (-4.67,-2.33,0,2.33,4.67):
    height = 10.65-abs(x)*1.33/7
    beam(frame, "Web upright", (x,0,9.32), (x,0,height), 0.10)
    toward_edge = x + (2.33 if x >= 0 else -2.33)
    beam(frame, "Web diagonal", (toward_edge,0,9.32), (x,0,height), 0.095)
beam(frame, "Pendant suspension", (0,0,9.32), (0,0,5.82), 0.035)
oval(frame, "Steel pendant shade", (0,0,5.80), (0.33,0.33,0.13), steel)
oval(frame, "Opal diffuser", (0,0,5.70), (0.265,0.265,0.064), opal)

def side_pendant(name, slope):
    side = asset(name)
    mount = block(side, "Mounting plate", (-0.022*math.sin(slope),0,-0.022*math.cos(slope)),
                  (0.11,0.11,0.044), steel, bevel=0)
    mount.rotation_euler.y = slope
    beam(side, "Pendant drop", (0,0,-0.023), (0,0,-2.24), 0.028)
    oval(side, "Wide pendant shade", (0,0,-2.24), (0.38,0.38,0.145), steel)
    oval(side, "Side pendant diffuser", (0,0,-2.36), (0.31,0.31,0.07), opal)


side_pendant("hall_side_pendant", -math.atan(0.267))
side_pendant("hall_side_pendant_flat", 0)

# Combine pieces by material within each asset to keep every streamed module
# to a small number of primitives without changing its placement origin.
for root in [obj for obj in bpy.context.scene.objects if obj.name.startswith("LIB_")]:
    by_material = {}
    for obj in root.children:
        by_material.setdefault(obj.data.materials[0], []).append(obj)
    for appearance, objects in by_material.items():
        for obj in objects:
            bpy.context.view_layer.objects.active = obj
            for modifier in list(obj.modifiers):
                bpy.ops.object.modifier_apply(modifier=modifier.name)
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        bpy.ops.object.join()
        objects[0].name = f"{root.name[4:]} {appearance.name}"

bpy.ops.export_scene.gltf(filepath=sys.argv[sys.argv.index("--")+1], export_format="GLB")
