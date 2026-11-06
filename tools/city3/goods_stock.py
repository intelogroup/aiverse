"""What each Bazaar stall sells and where it sits on the counter (pure data, no bpy). Own Random per stall index (6100+i / 5150+i): never draws
from the city rng, so later seeded layouts are untouched. Pieces come from goods.py (procedural, palette) and REAL (CC0 Sketchfab / Poly Haven)."""
import random
from goods import REAL, W

def width(k):
    if k in REAL: return REAL[k][5]
    for p,w in W.items():
        if k.startswith(p): return w
    return 0.6

ROWS_P=(-0.8,0.5); ROWS_M=(-0.22,0.28)          # customer-side offsets d (m from the stall centre toward the customer): back row, front row
SOLID=("r_grain","r_sack","r_barrel","r_pot","r_bucket","r_jug","r_basket","r_cheese","r_lantern")
def _w(p): return width(p[0]) if isinstance(p,tuple) else width(p)

def _row(rng,pool,d,umax,scale=1.0,gap=0.1,maxn=9):
    """Spread pieces from `pool` (a key, or (basket, mound, dz) tuple) along u in [-umax,umax]; returns [(key,u,d,rot,scale,dz)]."""
    items=[]; used=0.0; distinct=len(set(map(str,pool)))>1
    while True:
        p=rng.choice(pool)
        while items and p==items[-1] and distinct: p=rng.choice(pool)
        w=_w(p)*scale+gap
        if used+w>2*umax+gap or len(items)>=maxn: break
        items.append(p); used+=w
    if not items: return []
    ws=[_w(p)*scale for p in items]; tot=sum(ws)
    sp=min((2*umax-tot)/(len(items)-1),0.5) if len(items)>1 else 0.0
    x=-(tot+sp*(len(items)-1))/2; out=[]
    for p,w in zip(items,ws):
        u=x+w/2+rng.uniform(-0.03,0.03); x+=w+sp
        if isinstance(p,tuple):
            out.append((p[0],u,d,rng.uniform(0,6.28),scale,0.0)); out.append((p[1],u,d,rng.uniform(0,6.28),scale,p[2]))
        else: out.append((p,u,d,rng.uniform(0,6.28) if p.startswith(SOLID) else rng.uniform(-0.12,0.12),scale,0.0))
    return out

def _bk(m,dz=0.14): return ("r_basket",m,dz)
STOCK_W={"fruit":14,"veg":12,"grain":8,"spice":10,"cloth":12,"pottery":11,"bakery":9,"dairy":6,"wine":8,"lamps":7,"baskets":5}
def stock_of(i): return random.Random(5150+i).choices(list(STOCK_W),list(STOCK_W.values()))[0]

def layout(i,med):
    """Items for stall i: [(key,u,d,rot,scale,dz,hang)]. `med` = the village-stall counter (shallower, one front + one back row)."""
    rng=random.Random(6100+i); st=stock_of(i); rb,rf=(ROWS_M if med else ROWS_P); umax=1.15 if med else 1.5; hang=()
    cr=lambda *n: [f"crate_{x}" for x in n]
    if st=="fruit":
        a=_row(rng,[_bk(m) for m in rng.sample(["mound_apples","mound_oranges","mound_plums","mound_lemons","mound_tomatoes","mound_pears"],4)],rb,umax)
        b=_row(rng,cr("apples","greenapples","oranges","lemons","plums","pears","peppers")+["pyr_apples","pyr_oranges"],rf,umax)
    elif st=="veg":
        a=_row(rng,cr("greens","carrots","melons","beets"),rb,umax); b=_row(rng,cr("aubergines","peppers","tomatoes","beets","carrots","greens"),rf,umax)
        hang=("hang_onion","hang_garlic","hang_pepper")
    elif st=="grain":
        a=_row(rng,["r_grainsack","r_sack"],rb,umax,gap=0.05); b=_row(rng,["spice_d","spice_e","r_sack","r_grainsack"],rf,umax); hang=("hang_herbs","hang_garlic")
    elif st=="spice":
        a=_row(rng,["spice_a","spice_b","spice_c","spice_d"],rb,umax,1.3); b=_row(rng,["spice_c","spice_a","spice_e","spice_b"],rf,umax,1.3)
        hang=("hang_chili","hang_pepper","hang_garlic","hang_herbs","hang_onion")
    elif st=="cloth":
        a=_row(rng,["rolls_a","rolls_b","bolts_a","bolts_b","bolts_c"],rb,umax,gap=0.0); b=_row(rng,["folded_a","folded_b","bolts_c","bolts_b"],rf,umax)
        hang=("drape_0","drape_1","drape_2","drape_3","drape_4","drape_5")
    elif st=="pottery":
        a=_row(rng,["pots_terra","pots_blue","pots_green","pots_mixed"],rb,umax); b=_row(rng,["bowls","plates","r_pot"],rf,umax)
    elif st=="bakery":
        a=_row(rng,[_bk("rollpile",0.12)],rb,umax,gap=0.2); b=_row(rng,["loaves","baguettes","r_roll"],rf,umax)
    elif st=="dairy":
        a=_row(rng,["r_cheese","r_bucket","r_jug"],rb,umax); b=_row(rng,["wedges","r_cheese","loaves"],rf,umax)
    elif st=="wine":
        a=_row(rng,["r_barrel","bottles_green","bottles_amber"],rb,umax); b=_row(rng,["bottles_mixed","bottles_blue","goblets","bottles_green","bottles_amber"],rf,umax)
    elif st=="lamps":
        a=_row(rng,["ewers","r_lantern","goblets"],rb,umax); b=_row(rng,["r_lantern","goblets","ewers"],rf,umax); hang=("r_lantern",)
    else:
        a=_row(rng,["r_basket","r_bucket"],rb,umax,1.15); b=_row(rng,["r_basket",_bk("mound_lemons"),"r_bucket"],rf,umax,0.9); hang=("r_basket",)
    items=[o+(False,) for o in a+b]
    if hang and not med:                                          # hung from the awning's front rail, spread along u
        cloth=hang[0].startswith("drape"); n=3 if cloth else rng.randint(3,5)
        for k in range(n):
            p=hang[(i+k*2)%len(hang)] if cloth else rng.choice(hang)
            items.append((p,(k-(n-1)/2)*(3.0/n)+rng.uniform(-0.1,0.1),1.55,rng.uniform(-0.25,0.25),1.0 if p.startswith(("r_","drape")) else 0.8,0.0,True))
    return items
