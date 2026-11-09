"""Draw the measured walkable regions and verified routes, not just the room graph."""
from pathlib import Path
import base64
import json
import os
import sys
os.environ.setdefault('MPLCONFIGDIR','/tmp/aiverse-matplotlib')
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib.patches import Rectangle
from matplotlib.colors import ListedColormap
from matplotlib.backends.backend_pdf import PdfPages
import numpy as np

OUT=Path(__file__).resolve().parents[3]/'docs/procedural-city/tea-house'
p=json.loads((OUT/'plan.json').read_text())
a=json.loads((OUT/'route-audit.json').read_text())
assert a['status']=='PASS'

def mask(l):
    b=np.unpackbits(np.frombuffer(base64.b64decode(l['free']),dtype=np.uint8),bitorder='little')
    return b[:l['nx']*l['nz']].reshape(l['nz'],l['nx'])

def draw(ax,l):
    m=mask(l).astype(float)
    ds=l['minD']+(np.arange(l['nz'])+.5)*l['grid']
    m[ds<0,:]=np.nan
    extent=[l['minU'],l['minU']+l['nx']*l['grid'],l['minD'],l['minD']+l['nz']*l['grid']]
    ax.imshow(m,origin='lower',extent=extent,cmap=ListedColormap(['#737d82','#e3eee4']),vmin=0,vmax=1,interpolation='nearest')
    for r in l['rooms']:
        show=r['id'] in ('tea-seating','bar-staff','wc-a','tasting','salon','reading','pantry','rear-west','rear-east') or r['id'].endswith('-living')
        if show:
            for c in r['connections']:
                q=c['path']
                ax.plot([v[0] for v in q],[v[1] for v in q],color='#bf6f38' if c['stair']=='stair-a' else '#226d9c',alpha=.72,lw=1.1)
            if r['point']:
                u,d=r['point'];ax.scatter([u],[d],s=8,c='#1c5145',zorder=5)
                ax.text(u,d+.25,r['label'].replace(' / ',' /\n'),ha='center',fontsize=5.3,bbox=dict(facecolor='#faf8f1',alpha=.85,edgecolor='none',pad=1),zorder=6)
    for s in l['stairs']:
        u,d=s['point'];letter='A' if s['id']=='stair-a' else 'B'
        ax.text(u,d,letter,ha='center',va='center',fontsize=12,fontweight='bold',color='white',bbox=dict(boxstyle='circle',facecolor='#bf6f38' if letter=='A' else '#226d9c',edgecolor='white',pad=.25),zorder=9)
    ax.add_patch(Rectangle((0,0),25,12,fill=False,lw=1.1,color='#253f46'))
    if l['id']=='G':
        for route in a['exteriorContext']['routes']:
            pts=route['path'];ax.plot([q[0] for q in pts],[q[1] for q in pts],lw=1.5,color='#377a58',zorder=10)
        ax.add_patch(Rectangle((5.76,-1.29),.98,.98,facecolor='#8db394',edgecolor='#396547',lw=.8))
        ax.text(6.25,-1.65,'PLANTER MOVED',fontsize=5.5,ha='center',color='#396547')
        ax.text(17,-1.6,'TWO WEST CAFE SETS REMOVED',fontsize=5.5,ha='center',color='#995849')
    room_count=len(l['rooms']);maximum=max(min(c['distance'] for c in r['connections']) for r in l['rooms'])
    name=next(v['name'] for v in p['levels'] if v['id']==l['id'])
    ax.set_title(f'{l["id"]}  {name}\n{room_count} standing zones reach both stairs · longest nearest-stair route {maximum:.1f} m',loc='left',fontsize=9.2,fontweight='bold',pad=8)
    ax.set_xlim(-.5,25.5);ax.set_ylim(-3,12.8);ax.set_aspect('equal');ax.axis('off')

with PdfPages(OUT/'circulation-audit.pdf') as pdf:
    fig,axs=plt.subplots(2,2,figsize=(18,12),facecolor='#faf8f1')
    for ax,l in zip(axs.flat,a['levels']):draw(ax,l)
    fig.suptitle('TEA HOUSE  /  VERIFIED CIRCULATION',x=.05,y=.985,ha='left',fontsize=21,fontweight='bold')
    fig.text(.05,.94,f'{a["roomRoutes"]} room-to-stair routes · 0.80 m body width · 2.10 m headroom · measured on exported GLB at 5 cm grid spacing',fontsize=10,color='#536c73')
    fig.text(.05,.027,'Green areas = valid body centres; gray = clearance excluded. Orange routes → stair A; blue routes → stair B. Representative routes shown; all 102 checked.',fontsize=9,color='#536c73')
    fig.text(.05,.012,'Exterior traces include the required cafe removals and planter relocation. Private rooms are intentional single-entry destinations. This is a structure audit, not live navigation.',fontsize=8.5,color='#536c73')
    fig.subplots_adjust(top=.91,bottom=.05,hspace=.18,wspace=.08)
    fig.savefig(OUT/'circulation.png',dpi=150);pdf.savefig(fig);plt.close(fig)
    for l in a['levels']:
        fig,ax=plt.subplots(figsize=(16.5,10),facecolor='#faf8f1');draw(ax,l);pdf.savefig(fig);plt.close(fig)

if len(sys.argv)>1:
    before=json.loads(Path(sys.argv[1]).read_text())
    fig,axs=plt.subplots(1,2,figsize=(16,5.5),facecolor='#faf8f1')
    for ax,data,title in zip(axs,[before,a],['BEFORE: door leaves split the shared corridor','AFTER: both stairs reachable throughout']):
        l=next(l for l in data['levels'] if l['id']=='L2');m=mask(l)
        ax.imshow(m,origin='lower',extent=[.3,24.7,.3,11.7],cmap=ListedColormap(['#737d82','#dce9df']),interpolation='nearest')
        ax.add_patch(Rectangle((.3,4.3),24.4,1.5,fill=False,edgecolor='#d18b34',lw=1.3))
        ax.set_title(title,loc='left',fontsize=12,fontweight='bold');ax.set_aspect('equal');ax.axis('off')
    fig.text(.06,.03,'Same 0.80 m body width. The outlined band is the 1.50 m corridor; dark gaps in the earlier version were blocked by open door leaves.',fontsize=10,color='#536c73')
    fig.tight_layout(rect=[.03,.08,.98,.98]);fig.savefig(OUT/'circulation-before-after.png',dpi=140);plt.close(fig)
    summary=dict(before=dict(status=before['status'],roomRoutes=before['roomRoutes'],issues=len(before['issues'])),
                 after=dict(status=a['status'],roomRoutes=a['roomRoutes'],issues=len(a['issues']),doorways=len(a['portalChecks']),
                            minimumStairHeadroom=min(s['minimumHeadroom'] for s in a['stairChecks']),
                            stairSamples=sum(s['samples'] for s in a['stairChecks'])),
                 fixes=['Door swings moved into rooms; open lobby connections have no door leaf.',
                        'Stair B has direct ground lobby access, bypassing the store.',
                        'Sloping stair soffits replace solid fills that reduced headroom.',
                        'Stair edges and the unused top-floor upward flight are guarded.',
                        'Staff aisle has two 1.25 m gates; either can be blocked independently.',
                        'Entrance audit applies two cafe-set removals and relocation of one whole planter.'])
    (OUT/'audit-findings.json').write_text(json.dumps(summary,indent=2)+'\n')
print('Wrote measured circulation PNG/PDF.')
