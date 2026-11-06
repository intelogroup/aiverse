"""List every stall with its stock / med flag / facing / position (for picking screenshot targets). usage: python3 -I goods_report.py"""
import json, os, random, sys, types
HERE=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,HERE)
k=types.ModuleType("kit"); k.pal_uv=lambda c:(0,0); sys.modules["kit"]=k
import goods_stock as S
P=json.load(open(f"{HERE}/plan.json"))
med={i for i,_ in enumerate(P["stalls"]) if random.Random(4000+i).random()<0.35}
rows=[dict(i=i,stock=S.stock_of(i),med=i in med,facing=s["facing"],c=s["c"]) for i,s in enumerate(P["stalls"])]
json.dump(dict(walk_z=P["walk_z"],stalls=rows),open(sys.argv[1] if len(sys.argv)>1 else "/dev/stdout","w"),indent=0)
