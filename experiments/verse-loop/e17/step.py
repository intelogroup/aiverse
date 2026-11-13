import sys, json, urllib.request, datetime, os
# usage: step.py <name> <intent> '<action json>' <actid> [waitMs]   (name = ada|bo|cy|dee). Local stack only.
D=os.path.dirname(os.path.abspath(__file__)); BASE="http://127.0.0.1:3010/world"
name,intent,actjson,actid=sys.argv[1:5]; wait=int(sys.argv[5]) if len(sys.argv)>5 else 8000
TOK=open(f"{D}/{name}.token").read().strip(); H={"Authorization":"Bearer "+TOK,"Content-Type":"application/json"}
def req(m,p,b=None):
    r=urllib.request.Request(BASE+p,data=json.dumps(b).encode() if b is not None else None,headers=H,method=m)
    try:
        with urllib.request.urlopen(r,timeout=60) as f: return f.status,json.loads(f.read() or b'{}')
    except urllib.error.HTTPError as e: return e.code,json.loads(e.read() or b'{}')
rec={"utc":datetime.datetime.utcnow().isoformat()+"Z","intent":intent}
if actjson!="-":
    action=json.loads(actjson); rec["action"]=action
    st,res=req("POST","/act",{"id":actid,"action":action}); rec["submit"]=st
    if st in (200,202):
        st2,a=req("GET",f"/act/{actid}?waitMs={wait}"); o=(a.get("act") or {}).get("outcome") or {}
        rec["result"]={"state":(a.get("act") or {}).get("state"),"status":o.get("status"),"detail":o.get("detail"),"blockedBy":o.get("blockedBy")}
    else: rec["result"]={"status":"submit_failed","detail":str(res)[:300]}
st3,obs=req("GET","/observe"); o=obs.get("observation",obs); b=o.get("body",{})
rec["pose"]={"x":round(b.get("x",0),2),"z":round(b.get("z",0),2),"posture":b.get("posture"),"inside":o.get("insideRoom")}
print(json.dumps(rec)); print("HEARD:",json.dumps(o.get("heard",[])))
print("SCENE:",json.dumps([{k:s.get(k) for k in ("kind","id","name","bearingDeg","distance","posture")} for s in o.get("scene",[]) if s.get("kind") in("body","seat","door")][:12]))
print("NEAREST:",o.get("nearestPlace"))
open(f"{D}/{name}.jsonl","a").write(json.dumps(rec)+"\n")
