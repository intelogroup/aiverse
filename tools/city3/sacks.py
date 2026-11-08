"""Closed sack meshes, shared by the city generator and the shipped-GLB repair.
Y-up, bottom-centred. Rings share vertices: simplification must not erase cloth faces.
"""
import math


def sack_mesh(grain=False):
    width, depth, height = (.36, .3192, .5025) if grain else (.5183, .5336, .6091)
    profile = [(0, .63), (.07, .86), (.25, 1), (.55, .98), (.78, .86)]
    profile += [(.91, .71), (1, .75), (.98, .60), (.86, .57)] if grain else [(.88, .48), (.92, .23), (1, .37)]
    segments = 24
    vertices, faces, colors = [], [], []
    for j, (h, radius) in enumerate(profile):
        for k in range(segments):
            a = 2 * math.pi * k / segments
            fold = 1 + .035 * math.sin(6*a + .4*j) + .018 * math.cos(3*a)
            vertices.append((width*.5*radius*fold*math.cos(a), height*h, depth*.5*radius*fold*math.sin(a)))
    # Clockwise around Y when viewed from above; these triangles point outward.
    for j in range(len(profile)-1):
        for k in range(segments):
            a=j*segments+k; b=j*segments+(k+1)%segments; c=b+segments; d=a+segments
            faces += [(a,c,b),(a,d,c)]
            shade = .97 + .025*math.sin(k*2.3)
            colors += [tuple(v*shade for v in (.61,.49,.30))]*2
    for ring, y, bottom in [(0,0,True),(len(profile)-1,height*(.87 if grain else .95),False)]:
        centre=len(vertices); vertices.append((0,y,0))
        for k in range(segments):
            a=ring*segments+k; b=ring*segments+(k+1)%segments
            faces.append((centre,a,b) if bottom else (centre,b,a))
            colors.append((.73,.60,.36) if grain and not bottom else (.59,.47,.28))
    return vertices, faces, colors
