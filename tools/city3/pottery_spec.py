"""Pottery & metalware realism spec -- phase 2 (2026-11-08).

Source of truth for the lathe-goods forms that ship in world-city3.glb /
world-city3-library.glb after the procedural realism pass. The high-poly
masters and baked game meshes are produced by the Blender pipeline that
implements this spec (hero-goblet recipe: lathe profile with inner wall +
rolled rim -> closed solid -> subdivision + procedural displacement ->
procedural PBR -> bake to ~2-3k tris, 1024^2 maps). goods.py reads its
lathe profiles and handle arcs from these tables so a regeneration
reproduces the same forms (at generator fidelity); the baked GLBs carry
the full realism.

Profiles are (radius, z) point lists, base at z=0, revolved about Z.
Every profile closes the solid: foot -> outer wall -> rim roll -> inner
wall -> cavity floor -> axis. Handles are (points, tube radius) with the
endpoints buried inside the body wall. Glaze/metal parameters are the
values the procedural materials are built from.

r_pot note: the built r_pot piece replaces the Sketchfab "pot" import.
Its profile below is the shipped mesh's local envelope (0.234 m dia x
0.237 m); goods.py scales it by RPOT_GENERATOR_SCALE (the old REAL entry
applied 1.1 through the instance scale; the built path bakes it in), so
world placements keep their exact size.
"""

RPOT_GENERATOR_SCALE = 1.1

PROFILES = {'ewer': [(0, 0.004), (0.042, 0.002), (0.06, 0.0), (0.064, 0.006), (0.056, 0.018), (0.082, 0.048), (0.102, 0.098), (0.11, 0.148), (0.104, 0.19), (0.082, 0.235), (0.058, 0.262), (0.036, 0.288), (0.031, 0.318), (0.034, 0.338), (0.05, 0.36), (0.058, 0.376), (0.057, 0.38), (0.05, 0.383), (0.043, 0.378), (0.04, 0.356), (0.027, 0.33), (0.024, 0.3), (0.02, 0.282), (0, 0.276)], 'bowl': [(0, 0.004), (0.045, 0.002), (0.057, 0.0), (0.06, 0.005), (0.072, 0.018), (0.1, 0.045), (0.124, 0.072), (0.136, 0.092), (0.14, 0.099), (0.136, 0.1015), (0.129, 0.098), (0.124, 0.086), (0.104, 0.06), (0.072, 0.034), (0.032, 0.022), (0, 0.02)], 'jug': [(0, 0.004), (0.052, 0.002), (0.062, 0.0), (0.064, 0.006), (0.08, 0.03), (0.096, 0.08), (0.1, 0.14), (0.088, 0.195), (0.062, 0.24), (0.042, 0.27), (0.046, 0.3), (0.058, 0.322), (0.06, 0.33), (0.052, 0.332), (0.045, 0.326), (0.04, 0.3), (0.034, 0.272), (0.03, 0.25), (0.024, 0.232), (0, 0.226)], 'amphora': [(0, 0.004), (0.042, 0.002), (0.052, 0.0), (0.054, 0.008), (0.075, 0.05), (0.105, 0.12), (0.124, 0.19), (0.13, 0.24), (0.118, 0.31), (0.092, 0.375), (0.062, 0.43), (0.05, 0.47), (0.052, 0.515), (0.064, 0.555), (0.07, 0.578), (0.068, 0.58), (0.059, 0.582), (0.051, 0.574), (0.044, 0.52), (0.038, 0.478), (0.034, 0.44), (0.028, 0.415), (0, 0.405)], 'vase': [(0, 0.004), (0.042, 0.002), (0.052, 0.0), (0.054, 0.006), (0.072, 0.035), (0.092, 0.09), (0.1, 0.17), (0.088, 0.23), (0.062, 0.285), (0.037, 0.315), (0.042, 0.342), (0.05, 0.358), (0.049, 0.36), (0.041, 0.361), (0.035, 0.355), (0.03, 0.322), (0.026, 0.29), (0.022, 0.262), (0, 0.254)], 'pitcher': [(0, 0.003), (0.042, 0.0015), (0.052, 0.0), (0.054, 0.005), (0.068, 0.028), (0.078, 0.075), (0.08, 0.14), (0.07, 0.18), (0.058, 0.2), (0.066, 0.214), (0.07, 0.218), (0.061, 0.22), (0.054, 0.214), (0.048, 0.196), (0.042, 0.172), (0.036, 0.15), (0, 0.142)], 'potbowl': [(0, 0.003), (0.042, 0.0015), (0.052, 0.0), (0.054, 0.004), (0.082, 0.028), (0.118, 0.062), (0.14, 0.096), (0.145, 0.108), (0.139, 0.11), (0.132, 0.105), (0.127, 0.092), (0.1, 0.058), (0.058, 0.03), (0, 0.024)], 'urn': [(0, 0.004), (0.05, 0.002), (0.062, 0.0), (0.064, 0.006), (0.095, 0.05), (0.128, 0.12), (0.14, 0.2), (0.132, 0.265), (0.105, 0.325), (0.082, 0.358), (0.092, 0.382), (0.1, 0.396), (0.098, 0.4), (0.089, 0.401), (0.081, 0.394), (0.074, 0.362), (0.066, 0.33), (0.058, 0.3), (0, 0.29)], 'rpot': [(0, 0.003), (0.058, 0.0015), (0.072, 0.0), (0.075, 0.006), (0.098, 0.04), (0.113, 0.095), (0.117, 0.135), (0.108, 0.175), (0.092, 0.205), (0.088, 0.22), (0.096, 0.233), (0.098, 0.237), (0.089, 0.238), (0.081, 0.231), (0.076, 0.208), (0.082, 0.17), (0.09, 0.12), (0.07, 0.06), (0.03, 0.032), (0, 0.028)], 'goblet': [(0.0, 0.002), (0.02, 0.0012), (0.034, 0.0006), (0.039, 0.0), (0.04, 0.0025), (0.0385, 0.006), (0.03, 0.011), (0.016, 0.016), (0.0095, 0.022), (0.008, 0.034), (0.0085, 0.042), (0.015, 0.048), (0.0165, 0.053), (0.0145, 0.058), (0.0085, 0.063), (0.01, 0.07), (0.02, 0.076), (0.032, 0.088), (0.04, 0.104), (0.045, 0.122), (0.047, 0.14), (0.0478, 0.156), (0.0482, 0.168), (0.049, 0.176), (0.0495, 0.179), (0.0485, 0.1805), (0.0468, 0.1795), (0.0455, 0.175), (0.0445, 0.16), (0.042, 0.14), (0.036, 0.12), (0.026, 0.104), (0.014, 0.094), (0.0, 0.09)]}

HANDLES = {'ewer': ([(0.026, 0.318), (0.07, 0.312), (0.1, 0.272), (0.104, 0.228), (0.092, 0.192), (0.082, 0.18)], 0.0115), 'jug': ([(0.04, 0.3), (0.085, 0.285), (0.104, 0.235), (0.098, 0.18), (0.07, 0.135)], 0.011), 'amphora': ([(0.045, 0.52), (0.1, 0.49), (0.114, 0.375), (0.104, 0.3), (0.082, 0.24)], 0.013), 'pitcher': ([(0.045, 0.196), (0.088, 0.18), (0.104, 0.14), (0.088, 0.1), (0.066, 0.072)], 0.01)}

HEIGHTS = {'ewer': 0.383, 'bowl': 0.1015, 'jug': 0.332, 'amphora': 0.582, 'vase': 0.361, 'pitcher': 0.22, 'potbowl': 0.11, 'urn': 0.401, 'rpot': 0.238, 'goblet': 0.18}

BANDS = {'jug': (0.18, 0.82), 'amphora': (0.21, 0.86), 'vase': (0.22, 0.89), 'pitcher': (0.23, 0.64), 'urn': (0.25, 0.75), 'bowl': (0.05, 0.93), 'potbowl': None, 'rpot': None}

GLAZES = {'terra': ('#b8613a', '#8a3f2e', 0.88, 0.5), 'brick': ('#8a3f2e', '#b8613a', 0.5, 0.25), 'blue': ('#2d4a8c', '#6aa8d8', 0.3, 0.18), 'green': ('#3a6a3a', '#4f9a4c', 0.32, 0.18), 'cream': ('#e8e0cc', '#b8613a', 0.38, 0.12), 'ochre': ('#c9a227', '#b8613a', 0.42, 0.15)}

METALS = {'brass': ([(0.0, (0.24, 0.165, 0.055)), (0.3, (0.42, 0.29, 0.1)), (0.55, (0.62, 0.44, 0.16)), (0.8, (0.66, 0.47, 0.17)), (1.0, (0.92, 0.68, 0.3))], (0.16, 0.125, 0.045), [(0.0, 0.46), (0.5, 0.37), (0.9, 0.35), (1.0, 0.24)]), 'copper': ([(0.0, (0.28, 0.11, 0.045)), (0.3, (0.45, 0.2, 0.09)), (0.55, (0.62, 0.3, 0.13)), (0.8, (0.66, 0.33, 0.14)), (1.0, (0.88, 0.48, 0.26))], (0.13, 0.07, 0.035), [(0.0, 0.5), (0.5, 0.42), (0.9, 0.4), (1.0, 0.3)])}

ITEMS = {'ewer_brass': {'kind': 'ewer', 'mat': ('metal', 'brass'), 'tris': 2800}, 'ewer_copper': {'kind': 'ewer', 'mat': ('metal', 'copper'), 'tris': 2800}, 'bowl_terra': {'kind': 'bowl', 'mat': ('ceramic', 'terra'), 'tris': 2000}, 'bowl_ochre': {'kind': 'bowl', 'mat': ('ceramic', 'ochre'), 'tris': 2000}, 'pot_jug_terra': {'kind': 'jug', 'mat': ('ceramic', 'terra'), 'tris': 2600}, 'pot_amphora_terra': {'kind': 'amphora', 'mat': ('ceramic', 'terra'), 'tris': 2800}, 'pot_vase_brick': {'kind': 'vase', 'mat': ('ceramic', 'brick'), 'tris': 2400}, 'pot_pitcher_terra': {'kind': 'pitcher', 'mat': ('ceramic', 'terra'), 'tris': 2200}, 'pot_vase_blue': {'kind': 'vase', 'mat': ('ceramic', 'blue'), 'tris': 2400}, 'pot_jug_blue': {'kind': 'jug', 'mat': ('ceramic', 'blue'), 'tris': 2600}, 'pot_bowl_blue': {'kind': 'potbowl', 'mat': ('ceramic', 'blue'), 'tris': 2000}, 'pot_pitcher_cream': {'kind': 'pitcher', 'mat': ('ceramic', 'cream'), 'tris': 2200}, 'pot_amphora_green': {'kind': 'amphora', 'mat': ('ceramic', 'green'), 'tris': 2800}, 'pot_urn_green': {'kind': 'urn', 'mat': ('ceramic', 'green'), 'tris': 2600}, 'pot_jug_cream': {'kind': 'jug', 'mat': ('ceramic', 'cream'), 'tris': 2600}, 'pot_jug_ochre': {'kind': 'jug', 'mat': ('ceramic', 'ochre'), 'tris': 2600}, 'pot_urn_terra': {'kind': 'urn', 'mat': ('ceramic', 'terra'), 'tris': 2600}, 'pot_bowl_green': {'kind': 'potbowl', 'mat': ('ceramic', 'green'), 'tris': 2000}, 'rpot_terra': {'kind': 'rpot', 'mat': ('ceramic', 'terra'), 'tris': 2200}}
