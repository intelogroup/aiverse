// Physical route audit of the exported GLB, independent of plan-room connectivity.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const T=await import(path.join(root,'apps/console/node_modules/three/build/three.module.js'));
const {GLTFLoader}=await import(path.join(root,'apps/console/node_modules/three/examples/jsm/loaders/GLTFLoader.js'));
const {MeshoptDecoder}=await import(path.join(root,'apps/console/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js'));
const {MeshBVH}=await import(path.join(root,'apps/console/node_modules/three-mesh-bvh/build/index.module.js'));
globalThis.ProgressEvent??=class{constructor(type,fields){Object.assign(this,fields);this.type=type}};
const folder=path.join(root,'docs/procedural-city/tea-house');
const plan=JSON.parse(fs.readFileSync(path.join(folder,'plan.json')));
assert.match(fs.readFileSync(path.join(root,'apps/console/src/features/world/walker.ts'),'utf8'),/radius: 0\.4/);
assert.match(fs.readFileSync(path.join(root,'apps/console/src/features/world/teaDoor.ts'),'utf8'),/TEA_OPEN_ANGLE = 95/);
const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);loader.register(()=>({name:'routeMaterials',loadMaterial:()=>Promise.resolve(new T.MeshBasicMaterial({side:T.DoubleSide}))}));
async function load(p){const b=fs.readFileSync(p);const s=(await loader.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene;s.updateMatrixWorld(true);return s;}
const scene=await load(path.join(folder,'proposed-structure.glb'));
const source=await load(path.join(root,'apps/console/public/assets/world-city3-collision.glb'));
function bvhOf(objects,translate=false){
  const a=[],v=new T.Vector3();
  for(const o of objects){const g=o.geometry;for(let i=0;i<(g.index?.count??g.attributes.position.count);i++){
    const n=g.index?g.index.getX(i):i;v.fromBufferAttribute(g.attributes.position,n).applyMatrix4(o.matrixWorld);
    if(translate){v.x+=37.5;v.z+=72.5;}a.push(v.x,v.y,v.z);
  }}
  const g=new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(a,3));return new MeshBVH(g);
}
const meshes=[];scene.traverse(o=>{if(o.isMesh)meshes.push(o)});
for(const o of meshes)if(o.userData.category)assert.equal(o.userData.noGround,!['slab','stair'].includes(o.userData.category),`${o.name}: incorrect ground category`);
const tree=bvhOf(meshes);
const walkingSurfaces=bvhOf(meshes.filter(o=>o.name.endsWith('_slab')||o.name.endsWith('_stair')));
const groundMeshes=[];source.traverse(o=>{if(o.isMesh&&o.name==='col_ground')groundMeshes.push(o)});
const cityGround=bvhOf(groundMeshes,true);
const R=.4,HEIGHT=1.8,STEP=.4,GRID=.05;
const seg=new T.Line3(),bounds=new T.Box3(),plane=new T.Plane(),cross=new T.Vector3();
const ray=new T.Ray(),down=new T.Vector3(0,-1,0);
let volumeTests=0;
function blocked(u,d,y,bvh=tree,details=null){
  volumeTests++;seg.start.set(u,y+STEP+R,-d);seg.end.set(u,y+HEIGHT-R,-d);
  bounds.makeEmpty().expandByPoint(seg.start).expandByPoint(seg.end).expandByScalar(R);
  return bvh.shapecast({intersectsBounds:b=>b.intersectsBox(bounds),intersectsTriangle:tri=>{
    let hit=tri.closestPointToSegment(seg)<R-1e-4;
    if(!hit){tri.getPlane(plane);hit=!!plane.intersectLine(seg,cross)&&tri.containsPoint(cross);}
    if(hit&&details)details.triangle=[tri.a.toArray(),tri.b.toArray(),tri.c.toArray()];return hit;
  }});
}
function support(u,d,fromY,maxDrop=.4){
  ray.origin.set(u,fromY,-d);ray.direction.copy(down);
  const hits=walkingSurfaces.raycast(ray,T.DoubleSide,0,maxDrop);
  if(d<0)hits.push(...cityGround.raycast(ray,T.DoubleSide,0,maxDrop));
  return hits.filter(h=>h.face.normal.y>.6).sort((a,b)=>b.point.y-a.point.y)[0]?.point.y??null;
}
function headroom(u,d,y){ray.origin.set(u,y+.02,-d);ray.direction.set(0,1,0);const hit=tree.raycastFirst(ray,T.DoubleSide,0,6);return hit?hit.distance+.02:Infinity;}
function simplify(points){return points.filter((p,i)=>!i||i===points.length-1||Math.abs((p[0]-points[i-1][0])*(points[i+1][1]-p[1])-(p[1]-points[i-1][1])*(points[i+1][0]-p[0]))>1e-7);}
const issues=[],levels=[],runtime=new Map();let roomRoutes=0;
for(const l of plan.levels){
  const minU=.3,minD=l.id==='G'?-2.4:.3,nx=Math.round(24.4/GRID),nz=Math.round((11.7-minD)/GRID),N=nx*nz;
  const free=new Uint8Array(N),heights=new Float32Array(N),component=new Int32Array(N).fill(-1);
  const coords=i=>[minU+(i%nx+.5)*GRID,minD+(Math.floor(i/nx)+.5)*GRID];
  for(let i=0;i<N;i++){
    const [u,d]=coords(i),y=support(u,d,l.floorY+.025,l.id==='G'?.4:.06);
    if(y===null||blocked(u,d,y)||headroom(u,d,y)<2.09)continue;
    free[i]=1;heights[i]=y;
  }
  const neighbours=i=>{const x=i%nx,z=Math.floor(i/nx);return [x?i-1:-1,x<nx-1?i+1:-1,z?i-nx:-1,z<nz-1?i+nx:-1].filter(j=>j>=0&&free[j]&&Math.abs(heights[j]-heights[i])<=STEP+.001)};
  const queue=new Int32Array(N),sizes=[];
  for(let start=0;start<N;start++)if(free[start]&&component[start]<0){
    const c=sizes.length;let a=0,b=1;queue[0]=start;component[start]=c;
    while(a<b){const i=queue[a++];for(const j of neighbours(i))if(component[j]<0){component[j]=c;queue[b++]=j}}
    sizes.push(b);
  }
  function nearest(u,d,radius=.4){
    const xx=Math.floor((u-minU)/GRID),zz=Math.floor((d-minD)/GRID),n=Math.ceil(radius/GRID);let best=-1,dist=Infinity;
    for(let z=Math.max(0,zz-n);z<=Math.min(nz-1,zz+n);z++)for(let x=Math.max(0,xx-n);x<=Math.min(nx-1,xx+n);x++){
      const i=z*nx+x;if(!free[i])continue;const [a,b]=coords(i),dd=Math.hypot(a-u,b-d);if(dd<=radius&&dd<dist){dist=dd;best=i;}
    }return best;
  }
  const stairs=l.rooms.filter(r=>r.kind==='stair').map(r=>{
    const u=r.rect[0]+2.0,d=6.6;const i=nearest(u,d,.65);return {id:r.id,index:i,component:i<0?-1:component[i],point:i<0?null:coords(i)};
  });
  function flood(s,inside){
    const parent=new Int32Array(N).fill(-1);if(s.index<0)return parent;let a=0,b=1;queue[0]=s.index;parent[s.index]=s.index;
    while(a<b){const i=queue[a++];for(const j of neighbours(i))if(parent[j]<0&&(!inside||coords(j)[1]>=.3)){parent[j]=i;queue[b++]=j}}
    return parent;
  }
  const parents=stairs.map(s=>flood(s,l.id==='G'));
  const outdoorParents=l.id==='G'?stairs.map(s=>flood(s,false)):parents;
  const rooms=[];
  for(const r of l.rooms){
    if(['shaft','lift','stair','bar'].includes(r.kind))continue;
    const rect=r.rect,u=(rect[0]+rect[2])/2,d=(rect[1]+rect[3])/2;let i=nearest(u,d,.65);
    // Pick a representative standing point inside the actual room, never through a partition.
    if(i>=0){const [x,z]=coords(i);if(!(x>rect[0]&&x<rect[2]&&z>rect[1]&&z<rect[3]))i=-1;}
    const connections=stairs.map((s,k)=>{
      const ok=i>=0&&parents[k][i]>=0;const points=[];
      if(ok){for(let at=i;points.length<N;at=parents[k][at]){points.push(coords(at));if(at===s.index)break;}roomRoutes++;}
      return {stair:s.id,reachable:ok,distance:ok?Math.round((points.length-1)*GRID*100)/100:null,path:ok?simplify(points):[]};
    });
    if(i<0||connections.some(c=>!c.reachable))issues.push({level:l.id,room:r.id,problem:i<0?'No body-clear standing point':'Cannot reach both stairs',stairs:connections.map(c=>({id:c.stair,reachable:c.reachable}))});
    rooms.push({id:r.id,label:r.label,point:i<0?null:coords(i),component:i<0?-1:component[i],connections});
  }
  // Doorway landing points: lift doors remain closed and the shaft is not an escape route.
  const liftIndex=nearest(18.35,7.8,.35);
  if(liftIndex<0||stairs.some((_,k)=>parents[k][liftIndex]<0))issues.push({level:l.id,problem:'Lift landing cannot reach both stairs'});
  const exits=[];
  if(l.id==='G')for(const u of [1.2,14.5833,23.8]){
    const i=nearest(u,-1.1,.45);const reach=stairs.map((_,k)=>i>=0&&outdoorParents[k][i]>=0);
    exits.push({u,point:i<0?null:coords(i),reachableFromStairs:reach});if(reach.some(x=>!x))issues.push({level:l.id,problem:'Street exit unreachable',u,reach});
  }
  const bits=Buffer.alloc(Math.ceil(N/8));for(let i=0;i<N;i++)if(free[i])bits[i>>3]|=1<<(i&7);
  const islands=sizes.flatMap((n,c)=>n>50?[]:[{cells:n,points:Array.from(component.entries()).filter(([,k])=>k===c).map(([i])=>coords(i))}]);
  levels.push({id:l.id,floorY:l.floorY,minU,minD,nx,nz,grid:GRID,free:bits.toString('base64'),components:sizes,islands,stairs,rooms,exits});
  function reachAvoiding(u,d,rect){
    const start=nearest(u,d,.15);if(start<0)return [false,false];
    const seen=new Uint8Array(N);let a=0,b=1;queue[0]=start;seen[start]=1;
    while(a<b){for(const j of neighbours(queue[a++]))if(!seen[j]){
      const [x,z]=coords(j);if(z<.3||(x>rect[0]&&x<rect[2]&&z>rect[1]&&z<rect[3]))continue;
      seen[j]=1;queue[b++]=j;
    }}return stairs.map(s=>s.index>=0&&!!seen[s.index]);
  }
  runtime.set(l.id,{nearest,parents,coords,reachAvoiding});
  console.log(l.id,'components',sizes.filter(x=>x>30),'room issues',issues.filter(x=>x.level===l.id).length);
}

// Both flights, full half landing turn, and departure/arrival landing for each storey.
const stairChecks=[];
for(let level=0;level<3;level++)for(const s of plan.levels[level].rooms.filter(r=>r.kind==='stair')){
  const y=plan.levels[level].floorY,up=plan.levels[level+1].floorY,n=plan.proposal.stairRisers[level],half=n/2,rise=(up-y)/n;
  const a=s.rect[0]+1.075,b=s.rect[0]+2.575,start=7.25,end=start+(half-1)*.28;
  const waypoints=[[a,6.6],[a,7.15],[a,end+.65],[b,end+.65],[b,7.15],[b,6.6]];
  const k=s.id==='stair-a'?0:1;
  for(const [id,u,d]of [[plan.levels[level].id,a,6.6],[plan.levels[level+1].id,b,6.6]]){
    const r=runtime.get(id),index=r.nearest(u,d,.15);
    if(index<0||r.parents[k][index]<0)issues.push({level:id,stair:s.id,problem:'Flight landing disconnected from room routes'});
  }
  let minimumHeadroom=Infinity,samples=0;const failures=[];
  for(let k=0;k<waypoints.length-1;k++){
    const from=waypoints[k],to=waypoints[k+1],count=Math.ceil(Math.hypot(to[0]-from[0],to[1]-from[1])/.025);
    for(let j=0;j<=count;j++){
      const t=j/count,u=from[0]+(to[0]-from[0])*t,d=from[1]+(to[1]-from[1])*t;
      let expected;
      if(k<=1)expected=d<start?y:d<end?y+Math.min(half-1,Math.floor((d-start)/.28)+1)*rise:y+half*rise;
      else if(k===2)expected=y+half*rise;
      else expected=d<start?up:d<end?y+(half+Math.min(half-1,Math.floor((end-d)/.28)+1))*rise:y+half*rise;
      const actual=support(u,d,expected+.025,.08);
      if(actual===null){failures.push({problem:'Missing tread/landing',u,d,expected});continue;}
      const clearance=headroom(u,d,actual);minimumHeadroom=Math.min(minimumHeadroom,clearance);samples++;
      if(blocked(u,d,actual)||clearance<plan.proposal.stairHeadroomMinimum-.01)failures.push({problem:'Body/head collision',u,d,y:actual,headroom:Number.isFinite(clearance)?clearance:null});
    }
  }
  if(failures.length)issues.push({level:plan.levels[level].id,stair:s.id,problem:'Stair walking path blocked',count:failures.length,examples:failures.slice(0,4)});
  stairChecks.push({id:s.id,from:plan.levels[level].id,to:plan.levels[level+1].id,samples,minimumHeadroom:Number.isFinite(minimumHeadroom)?minimumHeadroom:null,failures:failures.length});
}
// A straight corridor must be clear, without detours through somebody's room.
for(const l of plan.levels.slice(1))for(let u=.75;u<=24.25;u+=.025)if(blocked(u,5.05,l.floorY)){
  issues.push({level:l.id,problem:'Straight public corridor pinched',u});break;
}
const barRedundancy=[];
for(const [id,rect]of [['west',[4.3,8.2,5.55,9.6]],['east',[11.55,8.2,12.8,9.6]]]){
  const reach=runtime.get('G').reachAvoiding(8.5,10.25,rect);barRedundancy.push({closedGate:id,bothStairsReachable:reach.every(Boolean)});
  if(reach.some(x=>!x))issues.push({level:'G',problem:'Staff aisle trapped by one blocked gate',closedGate:id});
}
const portalChecks=[];
for(const l of plan.levels)for(const d of l.doors){
  if(d.mode==='hatch'||d.mode==='lift')continue;
  const failures=[];
  for(let t=-.35;t<=.351;t+=.025){
    const u=d.axis==='d'?d.center:d.at+t,depth=d.axis==='d'?d.at+t:d.center;
    if(blocked(u,depth,l.floorY)||headroom(u,depth,l.floorY)<2.09)failures.push({u,d:depth});
  }
  portalChecks.push({level:l.id,from:d.a,to:d.b,mode:d.mode,clear:!failures.length});
  if(failures.length)issues.push({level:l.id,problem:'Human doorway crossing blocked',from:d.a,to:d.b,examples:failures.slice(0,2)});
}
let guardChecks=0;
for(let i=0;i<3;i++)for(const s of plan.levels[i].rooms.filter(r=>r.kind==='stair')){
  const y=plan.levels[i].floorY,n=plan.proposal.stairRisers[i],rise=(plan.levels[i+1].floorY-y)/n;
  const tread=y+(Math.floor((9-7.25)/.28)+1)*rise;
  assert(blocked(s.rect[0]+1.74,9,tread),'Missing inner stair guard');guardChecks++;
  assert(blocked(s.rect[0]+.41,9,tread),'Missing outer stair guard');guardChecks++;
}
for(const s of plan.levels[3].rooms.filter(r=>r.kind==='stair')){
  assert(blocked(s.rect[0]+1.075,7.3,11.4),'Unused upper flight must be closed with a guard');guardChecks++;
}
for(const l of plan.levels){assert(blocked(18.35,8.55,l.floorY),'Lift shaft must not be an open walking route');guardChecks++;}

// Resolve exterior conflicts against the shipped city, not an empty surrounding plane.
const city=await load(path.join(root,'apps/console/public/assets/world-city3.glb'));
const allProps=[],retainedProps=[];let removedTriangles=0,movedPlanterTriangles=0;
const cafeCenters=[9.3833,11.5833];
city.traverse(o=>{
  if(!o.isMesh||o.name!=='Props')return;const g=o.geometry,a=g.attributes.position;
  for(let k=0;k<(g.index?.count??a.count);k+=3){
    const ps=[0,1,2].map(j=>new T.Vector3().fromBufferAttribute(a,g.index?g.index.getX(k+j):k+j).applyMatrix4(o.matrixWorld)).map(v=>[v.x+37.5,v.y,v.z+72.5]);
    if(!ps.every(([u,y,z])=>u>=-1&&u<=26&&-z>=-3&&-z<=-.35&&y>=.19&&y<=3.2))continue;
    allProps.push(...ps.flat());
    // Semantic height sets distinguish overlapping planter and cafe parts in the merged Props mesh.
    const planter=ps.every(([x,y,z])=>x>=12&&x<=13&&-z>=-1.81&&-z<=-.79&&[.2,.7,.75,.8,.82,1.15,1.5].some(h=>Math.abs(h-y)<.001));
    if(planter){movedPlanterTriangles++;retainedProps.push(...ps.map(([x,y,z])=>[x-6.25,y,z-.5]).flat());continue;}
    const remove=cafeCenters.some(u=>ps.every(([x,y,z])=>Math.abs(x-u)<=1.26&&Math.abs(-z+1.55)<=1.26&&[.2,.64,.68,.92,.94,.98,1.1,2.35,2.6,2.8].some(h=>Math.abs(h-y)<.001)));
    if(remove)removedTriangles++;else retainedProps.push(...ps.flat());
  }
});
const propColliders=[];source.traverse(o=>{if(o.isMesh&&o.name==='col_props')propColliders.push(o)});
const cityPropTree=bvhOf(propColliders,true);
const treeFrom=a=>new MeshBVH(new T.BufferGeometry().setAttribute('position',new T.Float32BufferAttribute(a,3)));
const beforeProps=treeFrom(allProps),afterProps=treeFrom(retainedProps);
const exterior=[];
for(const [id,waypoints]of [
  ['exit-a',[[1.2,6.6],[1.2,-2.7]]],['exit-b',[[23.8,6.6],[23.8,-2.7]]],
  ['main-ramp',[[10.0,-2.7],[10.0,-1.05],[14.5833,-1.05],[14.5833,.9]]],
]){
  let previousY=.48,samples=0,before=0;const failures=[];const points=[];
  if(id==='main-ramp')previousY=.2;
  for(let k=0;k<waypoints.length-1;k++){
    const a=waypoints[k],b=waypoints[k+1],count=Math.ceil(Math.hypot(a[0]-b[0],a[1]-b[1])/.025);
    for(let j=0;j<=count;j++){
      const t=j/count,u=a[0]+(b[0]-a[0])*t,d=a[1]+(b[1]-a[1])*t,y=support(u,d,previousY+STEP+.02,STEP*2+.04);
      if(y===null||Math.abs(y-previousY)>STEP+.01){failures.push({u,d,problem:'Missing ground or excessive step'});continue;}
      if(blocked(u,d,y))failures.push({u,d,problem:'Blocked by proposal'});
      if(d<-.4){
        if(blocked(u,d,y,beforeProps))before++;
        const debug={};const visual=blocked(u,d,y,afterProps,debug),collider=blocked(u,d,y,cityPropTree,debug);
        if(visual||collider)failures.push({u,d,y,problem:'Blocked by retained exterior prop',visual,collider,...debug});
      }
      previousY=y;samples++;points.push([u,d,y]);
    }
  }
  if(failures.length)issues.push({level:'G',problem:'Exterior approach blocked',route:id,count:failures.length,examples:failures.slice(0,4)});
  exterior.push({id,samples,failures:failures.length,originalPropConflicts:before,path:points.filter((_,i)=>i%8===0)});
}
for(const l of levels)if(l.components.length!==1)issues.push({level:l.id,problem:'Disconnected standing area outside occupied-room checks',components:l.components,islands:l.islands});
assert.equal(movedPlanterTriangles,32,'Planter slice must retain its two 10-triangle boxes, soil quad, six leaves and four shipped flower faces');
const report={status:issues.length?'FAIL':'PASS',scope:'Physical body-clear route audit of structure proposal, not live controller or furnished layout',body:{radius:R,height:HEIGHT,stepUp:STEP,headroomMinimum:2.1},grid:GRID,volumeTests,roomRoutes,issues,stairChecks,barRedundancy,portalChecks,guardChecks,
  modelSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(folder,'proposed-structure.glb'))).digest('hex'),
  planSha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(folder,'plan.json'))).digest('hex'),
  exteriorContext:{status:'Audited with required cafe removals and planter relocation; live city unchanged',cafeCentersU:cafeCenters,cafeCenterD:-1.55,excludedSourceTriangles:removedTriangles,movedPlanterTriangles,planterMove:plan.proposal.exteriorChanges?.find(c=>c.id==='entrance-planter'),routes:exterior},
  intentionalTerminals:['Private rooms and bathrooms have a single entrance onto the shared circulation.','The lift/WC lobby is a short 2.7 m service branch, not an escape route.','The attic has no public access; the unused upward flight is guarded at L3.','Lift doors are closed; the shaft is excluded from walking routes.'],levels};
const dest=process.argv[2]?path.resolve(process.argv[2]):path.join(folder,'route-audit.json');fs.writeFileSync(dest,JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify({status:report.status,volumeTests,roomRoutes,issues,stairChecks,barRedundancy,exteriorContext:report.exteriorContext},null,2));
if(!process.argv[2])assert.equal(issues.length,0,'Physical route audit found problems');
