"""Package actual City 3 pose and event traces into a portable replay."""
import argparse
import json
from pathlib import Path


PAGE = """<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>The City That Outlives Its Owners</title>
<style>
:root{color-scheme:dark;font:16px system-ui;background:#11191d;color:#f2eee5}
body{max-width:1050px;margin:auto;padding:28px 20px}
h1{font:clamp(30px,5vw,52px) Georgia,serif;margin:0 0 12px}
p{color:#c1c6c3} main{display:grid;grid-template-columns:1fr 1fr;gap:24px}
canvas{width:100%;background:#17252a;border:1px solid #344e55;border-radius:8px}
button,select{background:#24373e;color:inherit;border:1px solid #54707a;padding:8px 12px;border-radius:5px}
.controls{display:flex;align-items:center;gap:10px;margin:20px 0}
input{flex:1} ol{padding-left:24px;line-height:1.6} li{margin-bottom:7px}
time{color:#8ecfd0;font-variant-numeric:tabular-nums} #notice{color:#f1cb80}
@media(max-width:680px){main{grid-template-columns:1fr}}
</style>
<h1>The City That Outlives Its Owners</h1>
<p>City 3 guide desk pilot · Top-down replay from recorded simulator positions.</p>
<div class="controls">
<label>Run <select id="run"></select></label>
<button id="play">Pause</button><label for="time" id="clock">0 s</label>
<input id="time" type="range" min="0" step="0.1" aria-label="Replay time">
</div>
<main>
<canvas width="530" height="615" aria-label="Recorded City 3 movement map"></canvas>
<section><h2 id="result"></h2><p id="notice"></p><ol id="events"></ol></section>
</main>
<script type="application/json" id="data">__DATA__</script>
<script>
const data = JSON.parse(document.querySelector('#data').textContent);
const run = document.querySelector('#run'), slider = document.querySelector('#time');
const clock = document.querySelector('#clock'), play = document.querySelector('#play');
const canvas = document.querySelector('canvas'), ctx = canvas.getContext('2d');
const colors = {Mara:'#e58d80',Ivo:'#89bec0',Sana:'#d9ab65',Niko:'#ad9ddb',Visitor:'#f4ed91'};
const names = {'shop-102':'Tea House','shop-96':"Sage’s Library",'shop-98':'Kronikler Press'};
const captions = {
  desk_opened:e=>e.actor+' opened the desk at '+names[e.place],
  desk_closed:e=>'The Tea House desk closed',
  organizer_visit_revoked:e=>'The gateway denied the organizer’s world access',
  notice_written:e=>e.actor+' left a notice at the old desk',
  notice_read:e=>e.forced?'The visitor was shown the seeded notice':
    e.text?'The visitor read the relocation notice':'The visitor found an empty board',
  wrong_venue:e=>'The visitor searched the Press',
  guide_received:e=>'The visitor heard the guide answer at the new desk',
};
for (const [i, item] of data.runs.entries()) run.add(new Option(item.name,i));
let playing = true, last = performance.now(), previous;
function selected(){return data.runs[Number(run.value)];}
function reset(){
  const item=selected(); slider.max=item.events.at(-1).t; slider.value=0; previous=null;
  document.querySelector('#result').textContent=item.summary.guide_received?'Guide answer delivered':
    item.summary.error?'Run interrupted':'Guide answer undelivered';
}
function xy(x,z){return [265+(x+16)*2.45,344-z*2.1];}
function marker(x,z,r,color){
  ctx.beginPath();ctx.arc(...xy(x,z),r,0,2*Math.PI);ctx.fillStyle=color;ctx.fill();
}
function render(){
  const t=Number(slider.value), item=selected();
  clock.textContent=Math.floor(t)+' s';
  const visible=item.events.filter(e=>e.t<=t);
  ctx.clearRect(0,0,530,615);
  data.places.forEach(p=>marker(...p.pos,1.7,'#3b555d'));
  for(const p of data.places.filter(p=>names[p.id])){
    marker(...p.pos,6,'#e3bb79');ctx.fillStyle='#f3e8cf';ctx.font='15px system-ui';
    const [x,y]=xy(...p.pos);ctx.fillText(names[p.id],x+13,y+5);
  }
  for(const [actor,color] of Object.entries(colors)){
    const path=visible.filter(e=>e.event==='pose'&&e.actor===actor);
    if(!path.length) continue;
    ctx.beginPath();ctx.lineWidth=1.8;ctx.globalAlpha=.55;ctx.strokeStyle=color;
    path.forEach((p,i)=>i?ctx.lineTo(...xy(p.x,p.z)):ctx.moveTo(...xy(p.x,p.z)));
    ctx.stroke();ctx.globalAlpha=1;
    if (visible.some(e=>e.event==='visit_stopped'&&e.actor===actor)) continue;
    const {x,z}=path.at(-1);marker(x,z,6,color);ctx.fillStyle=color;
    const [px,py]=xy(x,z);ctx.fillText(actor,px+9,py-8);
  }
  const story=visible.map(e=>{
    let caption=captions[e.event]?.(e);
    if(e.event==='receipt'&&e.receipt.outcome?.detail==='nobody within earshot heard you')
      caption=e.actor+' spoke, and nobody was within earshot';
    if(e.event==='choice'&&e.actor==='Visitor'&&e.choice==='wait')
      caption='The visitor stayed at the closed desk';
    return {e,caption};
  }).filter(item=>item.caption);
  if(previous===story.at(-1)?.e)return;
  previous=story.at(-1)?.e;
  const log=document.querySelector('#events');log.replaceChildren();
  story.forEach(({e,caption})=>{
    const li=document.createElement('li'), stamp=document.createElement('time');
    stamp.textContent=Math.floor(e.t)+'s ';li.append(stamp,caption);log.append(li);
  });
  document.querySelector('#notice').textContent=visible.find(e=>e.event==='notice_written')?.text||'';
}
function tick(now){
  if(playing){
    slider.value=Math.min(Number(slider.max),Number(slider.value)+(now-last)*.008);
    if(Number(slider.value)>=Number(slider.max)){playing=false;play.textContent='Replay';}
  }
  last=now;render();requestAnimationFrame(tick);
}
run.onchange=()=>{reset();playing=true;play.textContent='Pause';};
slider.oninput=()=>{playing=false;play.textContent='Play';render();};
play.onclick=()=>{
  if(Number(slider.value)>=Number(slider.max))reset();
  playing=!playing;play.textContent=playing?'Pause':'Play';
};
reset();requestAnimationFrame(tick);
</script>
</html>
"""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("runs", type=Path, nargs="+")
    assets = Path(__file__).resolve().parents[2] / "apps/console/public/assets"
    parser.add_argument("--places", type=Path, default=assets / "city3-places.json",
                        help="City 3 map from the revision that produced the pose traces")
    args = parser.parse_args()
    places = json.loads(args.places.read_text())
    runs = [{"name": path.name, "summary": json.loads((path / "summary.json").read_text()),
             "events": [json.loads(line) for line in (path / "events.jsonl").read_text().splitlines()]}
            for path in args.runs]
    payload = json.dumps({"places": places, "runs": runs}).replace("<", "\\u003c")
    args.output.write_text(PAGE.replace("__DATA__", payload))


if __name__ == "__main__":
    main()
