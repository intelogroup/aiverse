// Verify real exported geometry: slabs, shaft/stair holes, every tread, doors and bar access.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const T=await import(path.join(root,'apps/console/node_modules/three/build/three.module.js'));
const {GLTFLoader}=await import(path.join(root,'apps/console/node_modules/three/examples/jsm/loaders/GLTFLoader.js'));
globalThis.ProgressEvent??=class{constructor(type,fields){Object.assign(this,fields);this.type=type}};
const folder=path.join(root,'docs/procedural-city/tea-house');
const p=JSON.parse(fs.readFileSync(path.join(folder,'plan.json')));
const loader=new GLTFLoader();
loader.register(()=>({name:'geometryCheck',loadMaterial:()=>Promise.resolve(new T.MeshBasicMaterial({side:T.DoubleSide}))}));
async function load(name){const b=fs.readFileSync(path.join(folder,name));return (await loader.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene;}
const scene=await load('proposed-structure.glb');scene.updateMatrixWorld(true);
const meshes=[];let triangles=0;scene.traverse(o=>{if(o.isMesh){meshes.push(o);triangles+=(o.geometry.index?.count??o.geometry.attributes.position.count)/3;}});
assert(triangles<15000,`Structure exceeded 15k triangles: ${triangles}`);
function cast(u,d,y,direction,far,objects=meshes){return new T.Raycaster(new T.Vector3(u,y,-d),new T.Vector3(...direction),0,far).intersectObjects(objects,false);}
const slabObjects=meshes.filter(o=>o.name.endsWith('_slab'));
for(const [i,l]of p.levels.entries()){
  for(const [u,d]of [[5,2],[10,5],[16,7]]){
    const hit=cast(u,d,l.floorY+.08,[0,-1,0],.2,slabObjects)[0];
    assert(hit&&Math.abs(hit.point.y-l.floorY)<1e-4,`${l.id} missing floor at ${u},${d}`);
  }
  if(i>0){
    for(const [u,d]of [[2.1,8.5],[22.2,8.5],[18.35,10]])assert.equal(cast(u,d,l.floorY+.03,[0,-1,0],.3,slabObjects).length,0,`${l.id} slab fills a stair/lift opening`);
  }
  // Public hallway retains at least its planned 1.50 m width, after wall thickness.
  if(i>0){
    for(const d of [4.32,5.05,5.78])assert.equal(cast(5,d,l.floorY+1,[1,0,0],7).length,0,`${l.id} corridor obstructed at d=${d}`);
  }
}
const steps=JSON.parse(fs.readFileSync(path.join(folder,'blockout-metrics.json'))).stairs;
let treadChecks=0;
for(const s of steps){
  const l=p.levels.find(l=>l.id===s.fromLevel);const enclosure=l.rooms.find(r=>r.id===s.id).rect;
  const x=enclosure[0];const start=enclosure[1]+1.45;const end=start+s.run;const half=s.risers/2;
  const stairs=meshes.filter(o=>o.name===`${l.id}_stair`);
  assert(s.frontLanding>=1.25&&s.rearLanding>=1.25);
  for(let k=0;k<half-1;k++){
    for(const [u,d,expected]of [[x+1,start+(k+.5)*.28,l.floorY+(k+1)*s.riserHeight],[x+2.5,end-(k+.5)*.28,l.floorY+(half+k+1)*s.riserHeight]]){
      const hit=cast(u,d,expected+.03,[0,-1,0],.07,stairs)[0];
      assert(hit&&Math.abs(hit.point.y-expected)<1e-4,`${s.id} ${s.fromLevel}: missing tread ${k}`);treadChecks++;
    }
  }
}
// New front doors are true wall openings, rather than panels on the old facade.
const groundShell=meshes.filter(o=>o.name==='G_shell');
for(const u of [1.2,14.5833,23.8])assert.equal(cast(u,-.5,1.3,[0,0,-1],1,groundShell).length,0,`front door ${u} blocked by shell`);
// A walker-width passage actually reaches the staff aisle around the counter end.
for(const u of [11.8,12.1,12.4])assert.equal(cast(u,7.5,1.35,[0,0,-1],2.9).length,0,`bar staff approach blocked at ${u}`);
const pit=cast(18.35,10,.55,[0,-1,0],1.2)[0];assert(pit&&Math.abs(pit.point.y+.52)<1e-4,'Lift pit is not open to the reserved depth');
for(const t of [.1,.5,.9]){
  const hit=cast(10.34+3.36*t,-1.0,.7,[0,-1,0],1,slabObjects)[0];
  assert(hit&&Math.abs(hit.point.y-(.2+.28*t))<1e-4,'Entrance ramp slope mismatch');
}
const survey=await load('existing-shell.glb');survey.updateMatrixWorld(true);
const b=new T.Box3().setFromObject(survey);
assert(Math.abs(b.max.y-20.302)<.01);assert(Math.abs(b.min.y-.2)<.01);
const report={status:'PASS',triangles,treadChecks,floors:4,checks:['floor surfaces','upper stair and elevator slab openings','clear upper corridors','two complete stair runs per storey','three real street door openings','staff access around the shortened counter','open elevator pit','graded entrance ramp','survey height']};
fs.writeFileSync(path.join(folder,'geometry-check.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));
