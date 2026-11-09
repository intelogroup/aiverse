// @vitest-environment node
import {beforeAll,afterAll,expect,it} from 'vitest';
import {readFileSync} from 'node:fs';
import * as T from 'three';
import {GLTFLoader} from 'three/addons/loaders/GLTFLoader.js';
import {MeshoptDecoder} from 'three/addons/libs/meshopt_decoder.module.js';
import {bakeCollisionParts,boxesMesh,createCapsuleWorld,disposeCollider} from '../src/features/world/capsuleWorld';
import {makeWalker,step,moveToIntent} from '../src/features/world/walker';
import {ScoutExecutor,type Sittable} from '../src/features/world/scout';
import {ClipTestState} from '../src/features/world/clips';
import {BARTENDER_COLLIDER} from '../src/features/world/bartender';
import {MeshBVH} from 'three-mesh-bvh';
import {teaCutHeight,teaFloorAt,teaViewTargetHeight} from '../src/features/world/teaBuilding';
globalThis.ProgressEvent ??= class {} as typeof ProgressEvent;
let meshes:T.Mesh[]=[];
const world=createCapsuleWorld(()=>meshes);
const at=(u:number,d:number):[number,number]=>[u-37.5,-72.5-d];
async function load(file:string){const b=readFileSync(new URL('../public/assets/'+file,import.meta.url));const loader=new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);loader.register(()=>({name:'testMaterials',loadMaterial:()=>Promise.resolve(new T.MeshBasicMaterial())}));return (await loader.parseAsync(b.buffer.slice(b.byteOffset,b.byteOffset+b.byteLength),'')).scene;}
beforeAll(async()=>{
  meshes=bakeCollisionParts(await load('world-city3-collision.glb'));
  const col=JSON.parse(readFileSync(new URL('../public/assets/interiors/tea.col.json',import.meta.url),'utf8'));
  const furniture=boxesMesh(col.boxes,[0,0],'tea-furniture');if(furniture)meshes.push(furniture);
  const remy=boxesMesh([BARTENDER_COLLIDER],[0,0],'Remy');if(remy)meshes.push(remy);
});
afterAll(()=>meshes.forEach(disposeCollider));
function reach(s:ReturnType<typeof makeWalker>,u:number,d:number,maxSeconds=20){const [x,z]=at(u,d);for(let i=0;i<maxSeconds*60;i++){
  if(Math.hypot(s.x-x,s.z-z)<.06)return;
  const wanted=Math.atan2(x-s.x,z-s.z);s.heading=wanted;
  step(s,moveToIntent(s,[x,z],.04).input,1/60,world);
}throw new Error(`Blocked heading to (${u},${d}); at (${s.x+37.5},${-s.z-72.5},${s.y})`);}
it('uses four real floor datums and leaves the lift pit open below the original island ground',()=>{
  for(const y of [.48,4.4,7.9,11.4]){const[x,z]=at(10,5.05);expect(world.groundY(x,z,y+.1)).toBeCloseTo(y,4);}
  const[x,z]=at(18.35,10);expect(world.groundY(x,z,.55)).toBeCloseTo(-.52,4);
  expect(meshes.some(m=>m.userData.noGround)).toBe(true);
});
it('walks both full staircases up three storeys and down again with the production walker',()=>{
  for(const x0 of [.3,20.4]){
    const[x,z]=at(x0+1.075,6.6),s=makeWalker(x,.48,z,Math.PI);
    for(let i=0;i<3;i++){
      const n=i===0?24:22,end=7.25+(n/2-1)*.28;
      for(const[u,d]of [[x0+1.075,7.15],[x0+1.075,end+.65],[x0+2.575,end+.65],[x0+2.575,7.15],[x0+2.575,6.6]])reach(s,u,d);
      expect(s.y).toBeCloseTo([4.4,7.9,11.4][i],2);
    }
    for(let i=2;i>=0;i--){
      const n=i===0?24:22,end=7.25+(n/2-1)*.28;
      for(const[u,d]of [[x0+2.575,7.15],[x0+2.575,end+.65],[x0+1.075,end+.65],[x0+1.075,7.15],[x0+1.075,6.6]])reach(s,u,d);
      expect(s.y).toBeCloseTo([.48,4.4,7.9][i],2);
    }
  }
});
it('keeps the public corridors and both ground street discharges usable',()=>{
  for(const y of [4.4,7.9,11.4]){const[x,z]=at(1,5.05),s=makeWalker(x,y,z,Math.PI/2);reach(s,24,5.05,30);expect(s.y).toBeCloseTo(y);}
  for(const u of [1.2,23.8]){const[x,z]=at(u,6.6),s=makeWalker(x,.48,z,0);reach(s,u,-2.7);expect(s.y).toBeCloseTo(.2);}
});
it('uses the shipped chair and booth approaches to sit and stand with Scout',async()=>{
  const anchors:Sittable[]=JSON.parse(readFileSync(new URL('../public/assets/city3-anchors.json',import.meta.url),'utf8'));
  const seats=anchors.filter(anchor=>anchor.building==='tea');
  expect(seats.map(seat=>seat.kind).sort()).toEqual(['booth','booth','chair','chair','chair','chair']);
  for(const seat of seats){
    const clips=new ClipTestState();
    const scout=new ScoutExecutor({places:[],sittables:[seat],clips,hipsY:.718});
    const [x,z]=seat.approach;
    const state=makeWalker(x,.48,z+.12,0);
    expect(world.blocked([x,.48,z],[x,.48,z],.4),seat.id).toBeNull();
    async function drive(action:Parameters<ScoutExecutor['submit']>[0]){
      const result=scout.submit(action,state);
      for(let i=0;i<600;i++)scout.tick(1/60,state,world);
      return Promise.race([result,Promise.resolve({status:'timeout'})]);
    }
    expect((await drive({type:'sit',sittable:seat.id})).status,seat.id).toBe('seated');
    expect(clips.current).toBe('SittingIdle');
    expect(scout.frameOverride()?.drop).toBeCloseTo(seat.seatHeight-.718);
    expect((await drive({type:'stand'})).status,seat.id).toBe('stood');
    expect(state.x).toBeCloseTo(x);
    expect(state.z).toBeCloseTo(z);
    expect(state.y).toBeCloseTo(.48);
  }
});
it('keeps a route behind Remy and both staff gates clear',()=>{
  const[x,z]=at(4.925,7.5),s=makeWalker(x,.48,z,Math.PI);
  for(const[u,d]of [[4.925,10.54],[12.175,10.54],[12.175,7.5]])reach(s,u,d);
});
it('walks the graded main entrance when the existing entrance pilot is open',()=>{
  const[x,z]=at(10,-2.7),s=makeWalker(x,.2,z,Math.PI);
  for(const[u,d]of [[10,-1.05],[14.5833,-1.05],[14.5833,1.1]])reach(s,u,d);
  expect(s.y).toBeCloseTo(.48);
});
it('prevents walking through upper windows or into the unbuilt lift',()=>{
  for(const y of [4.4,7.9,11.4]){const[x,z]=at(6.25,1.3),s=makeWalker(x,y,z,0);for(let i=0;i<180;i++)step(s,{forward:1,strafe:0,turn:0,run:false},1/60,world);expect(s.z).toBeLessThan(-72.9);expect(s.y).toBeCloseTo(y);}
  const[x,z]=at(18.35,7.8),s=makeWalker(x,.48,z,Math.PI);for(let i=0;i<120;i++)step(s,{forward:1,strafe:0,turn:0,run:false},1/60,world);expect(s.z).toBeGreaterThan(-80.8);expect(s.y).toBeCloseTo(.48);
});
it('furnishes the public and private restrooms and keeps their entrances usable',()=>{
  const bytes=readFileSync(new URL('../public/assets/world-city3.glb',import.meta.url));
  const gltf=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));
  const names=new Set(gltf.nodes.map((node:{name:string})=>node.name));
  const toilets=gltf.nodes.filter((node:{name:string})=>/^(G|L[123])_.*_toilet$/.test(node.name));
  expect(toilets).toHaveLength(12);
  for(const toilet of toilets){
    const room=toilet.name.slice(0,-'_toilet'.length);
    expect(names.has(room+'_sink')).toBe(true);
    expect(names.has(room+'_door_sign')).toBe(true);
    expect(names.has(room+'_splashback')).toBe(true);
    const [u,y,z]=toilet.translation;
    const [x,wz]=at(u,-z);
    expect(world.blocked([x,y,wz],[x,y,wz],.31),room).not.toBeNull();
  }
  for(const u of [13.9,15.8]){
    const [x,z]=at(u,8.05),walker=makeWalker(x,.48,z,Math.PI);
    reach(walker,u,9.65);
    reach(walker,u,8.05);
  }
});
it('ships distinct textured finishes, artwork and working light definitions on each upper floor',()=>{
  const bytes=readFileSync(new URL('../public/assets/world-city3.glb',import.meta.url));
  const gltf=JSON.parse(bytes.toString('utf8',20,20+bytes.readUInt32LE(12)));
  const house=gltf.nodes.find((node:{name:string})=>node.name==='TeaHouseStructure');
  const parts=house.children.map((i:number)=>gltf.nodes[i]);
  const paints=[];
  for(const floor of ['L1','L2','L3']){
    const material=(name:string)=>gltf.materials.find((m:{name:string})=>m.name===floor+'_'+name);
    const paint=material('plaster').pbrMetallicRoughness;
    paints.push(paint.baseColorFactor.join(','));
    expect(paint.baseColorTexture.index).toBeGreaterThanOrEqual(0);
    expect(material('door_wood').pbrMetallicRoughness.baseColorTexture.index).toBeGreaterThanOrEqual(0);
    expect(parts.filter((n:{name:string})=>n.name.startsWith(floor+'_picture_'))).toHaveLength(3);
    expect(parts.some((n:{name:string})=>n.name===floor+'_wainscot_face')).toBe(true);
    expect(parts.some((n:{name:string})=>n.name.startsWith(floor+'_ceiling_'))).toBe(true);
    const lights=parts.filter((n:{name:string})=>n.name.startsWith(floor+'_pendant_')&&n.extensions?.KHR_lights_punctual);
    expect(lights).toHaveLength(5);
    for(const light of lights){
      expect(gltf.extensions.KHR_lights_punctual.lights[light.extensions.KHR_lights_punctual.light].intensity).toBeGreaterThan(0);
    }
  }
  expect(new Set(paints).size).toBe(3);
});
it('moves the cut with the selected floor and the walker height on stairs',()=>{
  expect(teaCutHeight(2)).toBeCloseTo(10);expect(teaFloorAt(11.4)).toBe(3);
  expect(teaCutHeight(0,{x:-35,y:6,z:-82})).toBeCloseTo(8.1);
  for(let i=0;i<4;i++)expect(teaViewTargetHeight(i)-teaCutHeight(i)).toBeGreaterThan(.4);
});
it('connects every occupied ground and upper zone to both stairs with the shipped furniture and Remy present',()=>{
  const plan=JSON.parse(readFileSync(new URL('../../../docs/procedural-city/tea-house/plan.json',import.meta.url),'utf8'));
  const spacing=.1,nx=244,nz=114;
  const ray=new T.Ray(),up=new T.Vector3(0,1,0);
  function lowCeiling(x:number,z:number,y:number){ray.origin.set(x,y+.02,z);ray.direction.copy(up);return meshes.some(m=>!!(m.geometry.boundsTree as unknown as MeshBVH).raycastFirst(ray,T.DoubleSide,0,2.08));}
  let routes=0;
  for(const level of plan.levels){
    const free=new Uint8Array(nx*nz),component=new Int32Array(nx*nz).fill(-1),y=level.floorY;
    const point=(i:number)=>at(.35+(i%nx)*spacing,.35+Math.floor(i/nx)*spacing);
    for(let i=0;i<free.length;i++){
      const[x,z]=point(i),g=world.groundY(x,z,y+.025);if(g===null||Math.abs(g-y)>.025||lowCeiling(x,z,y))continue;
      if(!world.blocked([x,y,z],[x,y,z],.4))free[i]=1;
    }
    const queue=new Int32Array(free.length);let components=0;
    for(let start=0;start<free.length;start++)if(free[start]&&component[start]<0){
      let a=0,b=1;queue[0]=start;component[start]=components;
      while(a<b){const i=queue[a++],x=i%nx,z=Math.floor(i/nx);for(const j of[x?i-1:-1,x<nx-1?i+1:-1,z?i-nx:-1,z<nz-1?i+nx:-1])if(j>=0&&free[j]&&component[j]<0){component[j]=components;queue[b++]=j;}}
      components++;
    }
    const stairs=[2.3,22.4].map(u=>{
      let best=-1,d=Infinity;for(let i=0;i<free.length;i++)if(free[i]){const[x,z]=point(i),n=Math.hypot(x+37.5-u,-z-72.5-6.6);if(n<d){d=n;best=i;}}
      expect(d).toBeLessThan(.2);return component[best];
    });
    expect(stairs[0],level.id).toBe(stairs[1]);
    for(const room of level.rooms){
      if(['bar','shaft','lift','stair'].includes(room.kind))continue;
      const r=room.rect,ids=new Set<number>();for(let i=0;i<free.length;i++)if(free[i]){const[x,z]=point(i),u=x+37.5,d=-z-72.5;if(u>r[0]+.4&&u<r[2]-.4&&d>r[1]+.4&&d<r[3]-.4)ids.add(component[i]);}
      expect([...ids],`${level.id}/${room.id} must have no trapped standing area`).toEqual([stairs[0]]);routes+=2;
    }
  }
  expect(routes).toBe(102);
},15_000);
