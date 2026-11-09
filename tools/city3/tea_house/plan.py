"""Low-poly architectural concept; no bpy dependency. Produces the shared plan and drawings.
Run from any directory: python tools/city3/tea_house/plan.py
Local drawing coordinates: u east from west wall, d north from street wall; metres.
"""
from pathlib import Path
import hashlib
import json
import math
import runpy
import tempfile
import os

ROOT = Path(__file__).resolve().parents[3]
OUT = ROOT / 'docs/procedural-city/tea-house'
OUT.mkdir(parents=True, exist_ok=True)


def room(id, label, rect, kind='room', group=None):
    return dict(id=id, label=label, rect=rect, kind=kind, wallGroup=group or id,
                area=round((rect[2]-rect[0])*(rect[3]-rect[1]), 2))


def door(a, b, axis, at, center, width=1.0, label=None):
    return dict(a=a, b=b, axis=axis, at=at, center=center, width=width, label=label or '')


def core(level):
    return [room('stair-a', 'STAIR A', [.3, 5.8, 4.3, 11.7], 'stair'),
            room('stair-b', 'STAIR B', [20.4, 5.8, 24.7, 11.7], 'stair'),
            room('core-lobby', 'LIFT / WC LOBBY', [12.8, 5.8, 20.4, 8.5], 'circulation', 'public' if level == 0 else None),
            room('wc-a', 'ACCESSIBLE WC' if level < 2 else 'SHARED WC / SHOWER', [12.8, 8.5, 15, 11.7], 'wet'),
            room('wc-b', 'WC' if level < 2 else 'CLEANING / LINEN', [15, 8.5, 16.6, 11.7], 'wet' if level < 2 else 'service'),
            room('wet-riser', 'WET RISER', [16.6, 8.5, 17, 11.7], 'shaft'),
            room('lift', 'ELEVATOR', [17, 8.5, 19.7, 11.7], 'lift'),
            room('service-riser', 'SERVICES', [19.7, 8.5, 20.4, 11.7], 'shaft')]


def core_doors(level):
    return [door('core-lobby', 'wc-a', 'd', 8.5, 13.9, 1.0),
            door('core-lobby', 'wc-b', 'd', 8.5, 15.8, .9),
            door('core-lobby', 'lift', 'd', 8.5, 18.35, 1.1),
            door('core-lobby', 'wet-riser', 'd', 8.5, 16.8, .3),
            door('core-lobby', 'service-riser', 'd', 8.5, 20.05, .5)]


levels = []
grooms = core(0) + [
    room('left-exit', 'PROTECTED EXIT A', [.3, .3, 2.1, 5.8], 'circulation'),
    room('tea-seating', 'TEA HOUSE / SEATING', [2.1, .3, 12.8, 5.8], 'public', 'public'),
    room('entry', 'ENTRY / LOUNGE', [12.8, .3, 20.4, 5.8], 'public', 'public'),
    room('cloak', 'CLOAK / STORE', [20.4, .3, 22.9, 5.8], 'service'),
    room('right-exit', 'PROTECTED EXIT B', [22.9, .3, 24.7, 5.8], 'circulation'),
    room('bar-guests', 'BAR SEATING', [4.3, 5.8, 12.8, 8.2], 'public', 'public'),
    room('bar-counter', 'COUNTER - 4 BAYS', [4.3, 8.2, 11.3, 9.6], 'bar', 'public'),
    room('staff-entry', 'STAFF ACCESS', [11.3, 8.2, 12.8, 9.6], 'circulation', 'public'),
    room('bar-staff', 'STAFF AISLE 1.35 m', [4.3, 9.6, 12.8, 10.95], 'circulation', 'public'),
    room('bar-shelves', '4 COMPACT SHELVES', [4.3, 10.95, 12.8, 11.7], 'bar', 'public')]
gdoors = core_doors(0) + [door('street', 'entry', 'd', .3, 14.5833, 1.7, 'EXISTING MAIN ENTRANCE'),
    door('street', 'left-exit', 'd', .3, 1.2, 1.0, 'NEW EXIT A'),
    door('street', 'right-exit', 'd', .3, 23.8, 1.0, 'NEW EXIT B'),
    door('left-exit', 'stair-a', 'd', 5.8, 1.2),
    door('right-exit', 'stair-b', 'd', 5.8, 23.8),
    door('left-exit', 'tea-seating', 'u', 2.1, 3.5),
    door('entry', 'cloak', 'u', 20.4, 3.5),
    door('cloak', 'right-exit', 'u', 22.9, 3.5),
    door('bar-staff', 'core-lobby', 'u', 12.8, 7.7, 1.0)]
# The staff access is via the open end of the counter, not a door through a toilet.
gdoors[-1] = door('bar-guests', 'core-lobby', 'u', 12.8, 7.2, 1.1)
levels.append(dict(id='G', name='Tea House', floorY=.48, rooms=grooms, doors=gdoors))

for level, name in ((1, 'Tea salon & community'), (2, 'Residences 201-203'), (3, 'Residences 301-303')):
    rs = core(level) + [room('corridor', 'CORRIDOR 1.50 m', [.3, 4.3, 24.7, 5.8], 'circulation')]
    ds = core_doors(level) + [door('corridor', 'stair-a', 'd', 5.8, 2.3), door('corridor', 'stair-b', 'd', 5.8, 22.55),
                            door('corridor', 'core-lobby', 'd', 5.8, 16.0, 1.5)]
    if level == 1:
        for id, label, rect in [('tasting', 'TEA TASTING ROOM', [.3, .3, 8.5, 4.3]),
                                ('salon', 'COMMUNITY SALON', [8.5, .3, 16.6, 4.3]),
                                ('reading', 'READING LOUNGE', [16.6, .3, 24.7, 4.3]),
                                ('pantry', 'PANTRY / PREP', [4.3, 5.8, 8.55, 11.7]),
                                ('staff', 'STAFF / OFFICE', [8.55, 5.8, 12.8, 11.7])]:
            rs.append(room(id, label, rect, 'wet' if id == 'pantry' else 'room'))
            ds.append(door('corridor', id, 'd', rect[3] if rect[1] < 1 else rect[1], (rect[0]+rect[2])/2, 1.0))
    else:
        for i, (left, right) in enumerate(((.3, 8.5), (8.5, 16.6), (16.6, 24.7)), 1):
            apt = f'{level}0{i}'
            rs.extend([room(f'{apt}-living', f'{apt} LIVING / SLEEP', [left, .3, right-2.2, 4.3], 'home', apt),
                       room(f'{apt}-kitchen', f'{apt} KITCHEN', [right-2.2, .3, right, 2.1], 'home', apt),
                       room(f'{apt}-bath', f'{apt} BATH', [right-2.2, 2.1, right, 4.3], 'wet')])
            ds.extend([door('corridor', f'{apt}-living', 'd', 4.3, right-3.2, 1.0),
                       door(f'{apt}-living', f'{apt}-bath', 'u', right-2.2, 3.2, .9)])
        labels = ('LAUNDRY / UTILITY', 'RESIDENTS COMMON ROOM') if level == 2 else ('SHARED STUDY', 'RESIDENTS LOUNGE')
        for id, label, rect in [('rear-west', labels[0], [4.3, 5.8, 8.55, 11.7]), ('rear-east', labels[1], [8.55, 5.8, 12.8, 11.7])]:
            rs.append(room(id, label, rect, 'service' if level == 2 and id == 'rear-west' else 'room'))
            ds.append(door('corridor', id, 'd', 5.8, (rect[0]+rect[2])/2))
    levels.append(dict(id=f'L{level}', name=name, floorY=4.4+(level-1)*3.5, rooms=rs, doors=ds))

# Re-run the deterministic recipe in a temporary folder, never overwrite workshop plan.json.
old = os.getcwd()
with tempfile.TemporaryDirectory() as tmp:
    try:
        os.chdir(tmp)
        recipe = runpy.run_path(str(ROOT/'tools/city3/plan.py'))['plan']
    finally:
        os.chdir(old)
building = recipe['buildings'][102]
assert building['rect'] == [-37.5, 72.5, -12.5, 84.5] and building['floors'] == 4
index = json.loads((ROOT/'apps/console/public/assets/interiors/index.json').read_text())
assert next(x for x in index if x['id'] == 'tea')['lot'] == 'shop-102'
survey = json.loads((OUT/'survey.json').read_text())
assert abs(next(x for x in survey['meshes'] if x['name']=='B_Facade_ochre')['maxY']-14.9) < .01
assert abs(next(x for x in survey['meshes'] if x['name']=='RoofTileV4')['maxY']-18.5025) < .01

plan = dict(version=1, status='architectural blockout; not connected to live city', id='tea-building', lot='shop-102',
    dimensions=dict(width=25, depth=12, grossFloorArea=300, floors=4, totalGrossFloorArea=1200, shellThickness=.3, slabThickness=.18, partitionThickness=.12),
    coordinates=dict(units='metres', drawing='u east from west wall; d north from street frontage',
                     world='three.js X=u-37.5; Y=floorY; Z=-72.5-d', blender='X=u; Y=d; Z=floorY'),
    existing=dict(recipe=building, groundFloorY=.48, upperFloorY=[4.4, 7.9, 11.4], eavesY=14.9, ridgeY=18.5025, chimneyTopY=20.302,
                  upperInteriorsBuilt=False, sourceMeshSha256=survey['sha256']),
    proposal=dict(addStoreys=False, habitableAttic=False, frontageDoors=[1.2,14.5833,23.8],
                  groundShelfBays=4, shelfCentersU=[5.4,7.4,9.4,11.4], counterCentersU=[5.35,7.05,8.75,10.45], retainedBarLength=6.8, staffGateWidth=1.5,
                  publicCorridorWidth=1.5, groundExitPassageWidth=1.8, elevatorShaft=[17,8.5,19.7,11.7],
                  elevatorClearCarTarget=[1.6,2.1], elevatorDoor=1.1, shaftPitY=-.52, shaftTopY=15.2,
                  entranceLanding=[13.7,-1.8,15.5,0], entranceRamp=[10.34,-1.8,13.7,-.3], entranceRampRise=.28, entranceRampRun=3.36,
                  stairWidth=1.25, treadGoing=.28, landingMinimum=1.25, stairRisers=[24,22,22],
                  stackedWetCore=[12.8,8.5,17,11.7], secondaryWetStacksU=[8.35,16.45,24.55], secondaryWetStackD=4.15,
                  residentialUnits=6, programme='G cafe; L1 community; L2/L3 three studio homes each; pitched attic service space'),
    levels=levels,
    implementation=['Keep this proposal isolated from the shipped world until reviewed.',
                    'Replace the old solid ground ceiling with slabs cut for both stairs and elevator.',
                    'Create real front exit openings; do not place door panels against solid walls.',
                    'West/east are party walls; rear east half abuts another building. No doors or bedroom windows there.',
                    'Both stairs discharge to street through their own ground passages. Courtyard is not assumed to be an exit.',
                    'Stack toilets and services; residential baths use three additional vertical wet ducts at the corridor edge.',
                    'Add floor-specific cutaway, streaming, collision and multilevel navigation before making upper floors playable.',
                    'Door operation, elevator travel, furnishings, materials and detailing are later passes.'],
    review=['Concept for the virtual building; structural spans, fire ratings and lift supplier clearances are not engineered.',
            'Partition zones include half wall thickness; room areas are planning areas, not finished net measurements.',
            'Shared boundary faces may remain in the spatial survey; proposed shell is newly built simple geometry.'])


def verify(p):
    """Check complete partitions, shared-boundary doors and reachability, not just counts."""
    for level in p['levels']:
        rooms = level['rooms']; lookup = {r['id']: r for r in rooms}
        assert len(lookup) == len(rooms)
        us = sorted({.3, 24.7, *(r['rect'][i] for r in rooms for i in (0,2))})
        ds = sorted({.3, 11.7, *(r['rect'][i] for r in rooms for i in (1,3))})
        graph = {r['id']: set() for r in rooms}; graph['street'] = set()
        for a,b in zip(us,us[1:]):
            for c,d in zip(ds,ds[1:]):
                mid=((a+b)/2,(c+d)/2)
                owners=[r for r in rooms if r['rect'][0]<mid[0]<r['rect'][2] and r['rect'][1]<mid[1]<r['rect'][3]]
                assert len(owners)==1, (level['id'],mid,[r['id'] for r in owners])
        for a in rooms:
            for b in rooms:
                if a['id']!=b['id'] and a['wallGroup']==b['wallGroup']:
                    graph[a['id']].add(b['id'])
        for d in level['doors']:
            for id in (d['a'],d['b']):
                if id=='street': continue
                r=lookup[id]['rect']; axis=d['axis']; at=d['at']; lo=d['center']-d['width']/2; hi=d['center']+d['width']/2
                assert (abs(at-r[0])<1e-6 or abs(at-r[2])<1e-6) if axis=='u' else (abs(at-r[1])<1e-6 or abs(at-r[3])<1e-6), (level['id'],d,id)
                assert (r[1]<=lo and hi<=r[3]) if axis=='u' else (r[0]<=lo and hi<=r[2]), (level['id'],d,id)
            graph[d['a']].add(d['b']); graph[d['b']].add(d['a'])
        for target in ('stair-a','stair-b','lift'):
            seen={target}; queue=[target]
            while queue:
                for n in graph[queue.pop()]-seen: seen.add(n); queue.append(n)
            assert set(lookup)<=seen, (level['id'],target,set(lookup)-seen)
        assert math.isclose(sum(r['area'] for r in rooms),24.4*11.4,abs_tol=.02)
    # Both stair geometries fit their enclosures, including their larger ground rise.
    ys=[l['floorY'] for l in p['levels']]
    for i,n in enumerate(p['proposal']['stairRisers']):
        rise=(ys[i+1]-ys[i])/n; run=(n/2-1)*.28
        assert .15<=rise<=.18 and 2*rise+.28>=.58
        assert 2*1.25+run+.20 <= 5.9
    print('PASS: all 4 floors partitioned once; all room doors meet their boundaries; both stairs and lift reachable; stair runs fit.')


verify(plan)
(OUT/'plan.json').write_text(json.dumps(plan,indent=2)+'\n')

os.environ.setdefault('MPLCONFIGDIR', '/tmp/aiverse-matplotlib')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
from matplotlib.backends.backend_pdf import PdfPages
COLORS=dict(stair='#cf927b',lift='#88b2cb',shaft='#aeb5ba',wet='#a9c9d7',circulation='#e7dfbd',public='#d9c8a5',bar='#bc9b75',service='#c7c7b9',room='#d2dac7',home='#c9d8c6')


def draw_floor(ax,l):
    ax.set_facecolor('#faf8f1')
    for r in l['rooms']:
        u,d,v,e=r['rect']; ax.add_patch(Rectangle((u,d),v-u,e-d,facecolor=COLORS[r['kind']],edgecolor='#393e42',lw=.7))
        if r['kind']=='shaft': continue
        label=r['label'].replace(' / ',' /\n').replace('PROTECTED EXIT ','EXIT\n').replace('4 COMPACT SHELVES','4 SHELF BAYS').replace('ACCESSIBLE WC','ACCESSIBLE\nWC').replace('STAFF ACCESS','STAFF\nACCESS')
        if 'KITCHEN' in label or 'BATH' in label: label=label.replace(' ', '\n', 1)
        if 'COUNTER' not in label and 'AISLE' not in label and 'SHELF' not in label: label+=f'\n{r["area"]:.1f} m²'
        ax.text((u+v)/2,(d+e)/2,label,ha='center',va='center',fontsize=5.3 if v-u<2.5 or e-d<1.6 else 6.2,color='#233039')
    for d in l['doors']:
        lo=d['center']-d['width']/2; hi=d['center']+d['width']/2
        if d['axis']=='u': ax.plot([d['at']]*2,[lo,hi],color='#faf8f1',lw=3.3); ax.plot([d['at']-.10,d['at']+.10],[lo,lo],color='#243f50',lw=.8)
        else: ax.plot([lo,hi],[d['at']]*2,color='#faf8f1',lw=3.3); ax.plot([lo,lo],[d['at']-.1,d['at']+.1],color='#243f50',lw=.8)
    # The two U stairs have two flights and one shared half landing.
    for x0,x1 in ((.3,4.3),(20.4,24.7)):
        for k in range(11):
            y=7.25+k*.28
            ax.plot([x0+.45,x0+1.70],[y,y],color='#6e564d',lw=.55)
            ax.plot([x0+1.95,x0+3.20],[y,y],color='#6e564d',lw=.55)
        ax.annotate('',xy=(x0+1.05,9.8),xytext=(x0+1.05,7.3),arrowprops=dict(arrowstyle='->',color='#533c33',lw=1))
    ax.plot([0,25,25,0,0],[0,0,12,12,0],color='#283842',lw=2)
    for i in range(6):
        u=(i+.5)*25/6
        if l['id']=='G' and i==3: continue
        ax.plot([u-1.2,u+1.2],[0,0],color='#82b9c9',lw=3)
    for u in ([1.2,14.5833,23.8] if l['id']=='G' else []):
        ax.annotate('',xy=(u,.2),xytext=(u,-.75),arrowprops=dict(arrowstyle='->',color='#367474',lw=1.3))
    ax.text(12.5,-1.1,'SOUTH / STREET FRONT',ha='center',fontsize=7,color='#596871')
    ax.text(6,12.45,'COURTYARD SIDE',ha='center',fontsize=6,color='#596871')
    ax.text(18.7,12.45,'REAR NEIGHBOUR / PARTY WALL',ha='center',fontsize=6,color='#596871')
    ax.set_title(f'{l["id"]}  ·  {l["name"]}  ·  +{l["floorY"]:.2f} m',loc='left',fontsize=10,fontweight='bold',pad=9)
    ax.set_xlim(-.6,25.6); ax.set_ylim(-1.4,13.2); ax.set_aspect('equal'); ax.axis('off')


with PdfPages(OUT/'tea-house-structure.pdf') as pdf:
    fig,axs=plt.subplots(2,2,figsize=(18,12),facecolor='#faf8f1')
    for ax,l in zip(axs.flat,levels):draw_floor(ax,l)
    fig.suptitle('MATCHMAKER’S HOUSE  /  STRUCTURE & DIVISION',fontsize=21,fontweight='bold',x=.055,ha='left',y=.985)
    fig.text(.055,.935,'EXISTING 25 × 12 m FOOTPRINT  ·  FOUR FLOORS  ·  NO ADDED STOREYS  ·  LOW-POLY CONCEPT',fontsize=10,color='#596871')
    fig.text(.055,.015,'Planning zones include wall thickness. Blue = wet/lift; terracotta = stairs; cream = circulation. Geometry and dimensions: plan.json.',fontsize=9,color='#596871')
    fig.subplots_adjust(top=.9,bottom=.05,hspace=.18,wspace=.08)
    fig.savefig(OUT/'floor-plans.png',dpi=150); pdf.savefig(fig); plt.close(fig)
    for l in levels:
        fig,ax=plt.subplots(figsize=(16.5,10),facecolor='#faf8f1');draw_floor(ax,l)
        fig.text(.12,.035,'25.00 m overall × 12.00 m overall  |  External walls 0.30 m  |  Slabs 0.18 m  |  Partitions 0.12 m  |  Metres',fontsize=10)
        pdf.savefig(fig);plt.close(fig)
    fig,axs=plt.subplots(1,2,figsize=(16.5,10),gridspec_kw={'width_ratios':[1.3,1]},facecolor='#faf8f1')
    ax=axs[0]
    for i,l in enumerate(levels):
        y=l['floorY']; top=levels[i+1]['floorY'] if i<3 else 14.9
        ax.add_patch(Rectangle((0,y),25,top-y,fill=False,edgecolor='#4e5b65',lw=1))
        ax.add_patch(Rectangle((0,y-.18),25,.18,color='#9ba5a7'))
        ax.text(5,y+.5,f'{l["id"]}  {l["name"]}',fontsize=9)
        ax.text(-.6,y,f'+{y:.2f}',ha='right',fontsize=9)
    ax.plot([-.55,6,19,25.55],[14.9,18.5025,18.5025,14.9],color='#8d6557',lw=2)
    ax.text(12.5,16.3,'PITCHED ATTIC — SERVICES ONLY',ha='center',fontsize=9)
    ax.add_patch(Rectangle((17,-.52),2.7,15.72,facecolor='#88b2cb',alpha=.6))
    ax.text(18.35,6.5,'LIFT\nSHAFT',ha='center',fontsize=9)
    ax.text(18.35,-1.15,'Pit reservation −0.52 m',ha='center',fontsize=8)
    ax.set_xlim(-3,26);ax.set_ylim(-2,20);ax.set_aspect('equal');ax.axis('off');ax.set_title('SCHEMATIC STACK / HEIGHT DATUMS',loc='left',fontsize=13)
    axs[1].axis('off')
    text='CIRCULATION & SERVICES\n\nTwo stairs, each 1.25 m clear target.\nGround rise 3.92 m: 24 risers × 163 mm.\nUpper rise 3.50 m: 22 risers × 159 mm.\nGoing 280 mm; landing target ≥1.25 m.\n\nUpper corridor 1.50 m.\nSeparate ground exit passages 1.80 m.\nBoth discharge to the south street.\nCourtyard is not assumed to be an exit.\n\nLift shaft zone 2.70 × 3.20 m.\nCar target 1.60 × 2.10 m; door 1.10 m.\nStops: G / L1 / L2 / L3.\nShaft head +15.20 m, below roof slope.\n\nStacked common toilets and service riser.\nPrivate baths repeat on L2 and L3.\nSix studio homes, approx. 32–33 m² each.\n\nSlabs and stairs are built in the blockout.\nMaterials, furniture and movement come later.\n\nVirtual-world architectural concept.\nNot a certified structural or fire design.'
    axs[1].text(0,.98,text,va='top',fontsize=11,linespacing=1.55,color='#283842')
    fig.tight_layout();fig.savefig(OUT/'section.png',dpi=120);pdf.savefig(fig);plt.close(fig)
print('Wrote plan.json, floor-plans.png, section.png and tea-house-structure.pdf')
