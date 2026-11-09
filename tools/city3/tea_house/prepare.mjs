// Integrate only the Tea House and its audited entrance edits; retain legacy binary bytes.
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
const ROOT=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../../..');
const {MeshoptDecoder}=await import(path.join(ROOT,'apps/console/node_modules/three/examples/jsm/libs/meshopt_decoder.module.js'));
await MeshoptDecoder.ready;
const BASE='22ba63a';
const asset='apps/console/public/assets/';
const out=process.env.TEA_RUNTIME_OUT??path.join(ROOT,asset);
fs.mkdirSync(path.join(out,'interiors'),{recursive:true});
const baseline=name=>{
  const file=path.join('/tmp/aiverse-tea-baseline',name);fs.mkdirSync(path.dirname(file),{recursive:true});
  const fd=fs.openSync(file,'w');try{execFileSync('git',['show',`${BASE}:${asset}${name}`],{cwd:ROOT,stdio:['ignore',fd,'pipe']});}finally{fs.closeSync(fd);}return fs.readFileSync(file);
};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function read(bytes){const n=bytes.readUInt32LE(12);return {doc:JSON.parse(bytes.toString('utf8',20,20+n)),bin:bytes.subarray(28+n)};}
function edit(bytes){
  const {doc,bin}=read(bytes),originalBin=Buffer.from(bin);const chunks=[originalBin];let size=originalBin.length;
  const views=new Map(),attrs=new Map();
  function view(i){if(views.has(i))return views.get(i);const v=doc.bufferViews[i],e=v.extensions?.EXT_meshopt_compression;let bytes;
    if(e){bytes=new Uint8Array(e.count*e.byteStride);MeshoptDecoder.decodeGltfBuffer(bytes,e.count,e.byteStride,bin.subarray(e.byteOffset,e.byteOffset+e.byteLength),e.mode,e.filter);}else bytes=bin.subarray(v.byteOffset??0,(v.byteOffset??0)+v.byteLength);
    views.set(i,bytes);return bytes;
  }
  function attr(i){if(attrs.has(i))return attrs.get(i);const a=doc.accessors[i],v=doc.bufferViews[a.bufferView],data=view(a.bufferView),dv=new DataView(data.buffer,data.byteOffset,data.byteLength),width=({SCALAR:1,VEC2:2,VEC3:3,VEC4:4})[a.type],component=({5126:4,5125:4,5123:2,5122:2,5121:1,5120:1})[a.componentType];
    const stride=v.byteStride??width*component,values=[];
    for(let k=0;k<a.count;k++)for(let c=0;c<width;c++){
      const p=(a.byteOffset??0)+k*stride+c*component;let x;
      if(a.componentType===5126)x=dv.getFloat32(p,true);else if(a.componentType===5125)x=dv.getUint32(p,true);else if(a.componentType===5123)x=dv.getUint16(p,true);else if(a.componentType===5122)x=dv.getInt16(p,true);else if(a.componentType===5121)x=dv.getUint8(p);else x=dv.getInt8(p);
      if(a.normalized)x=a.componentType===5121?x/255:a.componentType===5123?x/65535:Math.max(x/(a.componentType===5122?32767:127),-1);values.push(x);
    }const r={values,width,count:a.count};attrs.set(i,r);return r;
  }
  function appendView(b){const pad=(4-size%4)%4;if(pad){chunks.push(Buffer.alloc(pad));size+=pad;}const i=doc.bufferViews.length;doc.bufferViews.push({buffer:0,byteOffset:size,byteLength:b.length});views.set(i,b);chunks.push(b);size+=b.length;return i;}
  function accessor(values,width=1,indices=false){const typed=indices?new Uint32Array(values):new Float32Array(values);const a={bufferView:appendView(Buffer.from(typed.buffer)),componentType:indices?5125:5126,count:values.length/width,type:({1:'SCALAR',2:'VEC2',3:'VEC3',4:'VEC4'})[width]};
    if(width===3){a.min=[Infinity,Infinity,Infinity];a.max=[-Infinity,-Infinity,-Infinity];values.forEach((v,i)=>{a.min[i%3]=Math.min(a.min[i%3],v);a.max[i%3]=Math.max(a.max[i%3],v)});}doc.accessors.push(a);return doc.accessors.length-1;
  }
  function indices(p){return p.indices===undefined?Array.from({length:attr(p.attributes.POSITION).count},(_,i)=>i):attr(p.indices).values;}
  function points(p,ids){const pos=attr(p.attributes.POSITION).values;return ids.map(i=>pos.slice(i*3,i*3+3));}
  function filter(node,p,fn){const old=indices(p),keep=[];let removed=0;
    for(let i=0;i<old.length;i+=3){const ids=old.slice(i,i+3),ps=points(p,ids);if(fn(ps,ids)){removed++;continue;}keep.push(...ids);}
    if(removed)p.indices=accessor(keep,1,true);return removed;
  }
  function addMesh(name,positions,material=0,extras={},attributes={}){
    const primitive={attributes:{POSITION:accessor(positions,3),...attributes},material};
    const mi=doc.meshes.length;doc.meshes.push({primitives:[primitive]});const ni=doc.nodes.length;doc.nodes.push({name,mesh:mi,extras});doc.scenes[doc.scene??0].nodes.push(ni);return primitive;
  }
  function box(name,rect,y0,y1,material,extras){const [x0,z0,x1,z1]=rect,v=[[x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1],[x0,y1,z0],[x1,y1,z0],[x1,y1,z1],[x0,y1,z1]],faces=[[0,3,2,1],[0,1,5,4],[1,2,6,5],[2,3,7,6],[3,0,4,7],[4,5,6,7]],positions=[];
    for(const [a,b,c,d]of faces.map(f=>f.reverse()))for(const i of[a,b,c,a,c,d])positions.push(...v[i]);return addMesh(name,positions,material,extras);
  }
  function append(addBytes,{collision=false}={}){
    const add=read(addBytes),keys=['bufferViews','accessors','images','samplers','textures','materials','meshes','nodes'],offset=Object.fromEntries(keys.map(k=>[k,(doc[k]??=[]).length]));
    const dataOffset=appendView(add.bin),payloadOffset=doc.bufferViews[dataOffset].byteOffset;
    // The payload container view itself is intentionally unused; its bytes host the remapped views.
    offset.bufferViews=doc.bufferViews.length;
    for(const [i,v]of add.doc.bufferViews.entries()){const start=v.byteOffset??0;views.set(i+offset.bufferViews,add.bin.subarray(start,start+v.byteLength));v.buffer=0;v.byteOffset=start+payloadOffset;}
    for(const a of add.doc.accessors)if(a.bufferView!==undefined)a.bufferView+=offset.bufferViews;
    for(const image of add.doc.images??[])image.bufferView+=offset.bufferViews;
    for(const t of add.doc.textures??[]){t.source+=offset.images;if(t.sampler!==undefined)t.sampler+=offset.samplers;}
    function textures(v){if(!v||typeof v!=='object')return;for(const[k,x]of Object.entries(v)){if(k.endsWith('Texture')&&x&&typeof x==='object'&&x.index!==undefined)x.index+=offset.textures;else textures(x);}}
    for(const m of add.doc.materials??[]){textures(m);if(m.name==='Structure_shell')m.pbrMetallicRoughness.baseColorFactor=[.64,.40,.18,1];}
    for(const m of add.doc.meshes)for(const p of m.primitives){p.attributes=Object.fromEntries(Object.entries(p.attributes).map(([k,v])=>[k,v+offset.accessors]));if(p.indices!==undefined)p.indices+=offset.accessors;if(p.material!==undefined)p.material+=offset.materials;}
    for(const n of add.doc.nodes){if(n.mesh!==undefined)n.mesh+=offset.meshes;if(n.children)n.children=n.children.map(i=>i+offset.nodes);if(collision)n.name='col_tea_'+n.name;}
    // Roof and open-pose main entrance study placeholders are replaced by the original city's roof and live door.
    const skip=new Set(add.doc.nodes.flatMap((n,i)=>n.name.includes('EXISTING_PITCHED_ROOF')?[i+offset.nodes]:[]));
    for(const n of add.doc.nodes)if(n.name.endsWith('G_door')){
      // Main door leaves are mixed with internal leaves: filter their 24 isolated placeholder triangles below.
      n.extras??={};n.extras.mainDoorStudyRemoved=true;
    }
    for(const k of keys)doc[k].push(...(add.doc[k]??[]));
    const root=doc.nodes.length;doc.nodes.push({name:collision?'col_tea_structure':'TeaHouseStructure',translation:[-37.5,0,-72.5],children:add.doc.scenes[add.doc.scene??0].nodes.map(i=>i+offset.nodes).filter(i=>!skip.has(i)),extras:{building:'tea',floorHeights:[.48,4.4,7.9,11.4]}});doc.scenes[doc.scene??0].nodes.push(root);
    for(const n of doc.nodes.slice(offset.nodes,root))if(n.name.endsWith('G_door'))for(const p of doc.meshes[n.mesh].primitives)filter(n,p,ps=>ps.every(([u,y,z])=>u>13.6&&u<15.6&&z>-.95&&z<.1&&y<2.7));
    for(const k of ['extensionsUsed','extensionsRequired'])for(const e of add.doc[k]??[])if(!(doc[k]??=[]).includes(e))doc[k].push(e);
  }
  function write(file){doc.buffers[0].byteLength=size;let j=Buffer.from(JSON.stringify(doc));j=Buffer.concat([j,Buffer.alloc((4-j.length%4)%4,32)]);let b=Buffer.concat(chunks);b=Buffer.concat([b,Buffer.alloc((4-b.length%4)%4)]);assert(b.subarray(0,originalBin.length).equals(originalBin));const h=Buffer.alloc(12),jh=Buffer.alloc(8),bh=Buffer.alloc(8);h.writeUInt32LE(0x46546c67);h.writeUInt32LE(2,4);h.writeUInt32LE(28+j.length+b.length,8);jh.writeUInt32LE(j.length);jh.writeUInt32LE(0x4e4f534a,4);bh.writeUInt32LE(b.length);bh.writeUInt32LE(0x004e4942,4);fs.writeFileSync(file,Buffer.concat([h,jh,j,bh,b]));}
  return {doc,attr,indices,points,filter,accessor,addMesh,box,append,write};
}
const local=ps=>ps.map(([x,y,z])=>[x+37.5,y,-z-72.5]);
const inHouse=ps=>ps.every(([u,y,d])=>u>=-.001&&u<=25.001&&d>=-.001&&d<=12.001);
const sourceWorld=baseline('world-city3.glb'),world=edit(sourceWorld),changes={sourceRevision:BASE,sourceSha256:sha(sourceWorld),removed:{},relocatedPlanterTriangles:0,removedCafeTriangles:0};
for(const n of [...world.doc.nodes]){
  if(n.mesh===undefined)continue;
  for(const p of world.doc.meshes[n.mesh].primitives){
    if(['B_Facade_ochre','InteriorWalls','WoodFloor'].includes(n.name))changes.removed[n.name]=world.filter(n,p,ps=>inHouse(local(ps)));
    if(n.name==='Glass')changes.removed.Glass=world.filter(n,p,ps=>{const q=local(ps);return inHouse(q)&&q.every(([,y])=>y<3.4)});
    if(n.name!=='Props')continue;
    const moved=[];
    changes.removed.Props=world.filter(n,p,(ps,ids)=>{
      const q=local(ps);
      const planter=q.every(([u,y,d])=>u>=12&&u<=13&&d>=-1.81&&d<=-.79&&[.2,.7,.75,.8,.82,1.15,1.5].some(h=>Math.abs(h-y)<.001));
      if(planter){moved.push(...ids);changes.relocatedPlanterTriangles++;return true;}
      const cafe=[9.3833,11.5833].some(c=>q.every(([u,y,d])=>Math.abs(u-c)<=1.26&&Math.abs(d+1.55)<=1.26&&[.2,.64,.68,.92,.94,.98,1.1,2.35,2.6,2.8].some(h=>Math.abs(h-y)<.001)));
      if(cafe){changes.removedCafeTriangles++;return true;}
      const oldStoop=q.every(([u,y,d])=>u>=13.27&&u<=15.89&&d>=-.851&&d<=.001&&y>=.19&&y<=.49);
      const oldEndWindow=q.every(([u,y,d])=>((u>.5&&u<4.1)||(u>20.9&&u<24.5))&&y>=.79&&y<=3.5&&d>=-.36&&d<=.31);
      return oldStoop||oldEndWindow;
    });
    const attrs={};let positions=[];
    for(const[k,a]of Object.entries(p.attributes)){const src=world.attr(a),values=[];for(const i of moved){const v=src.values.slice(i*src.width,(i+1)*src.width);if(k==='POSITION'){v[0]-=6.25;v[2]-=.5;}values.push(...v);}if(k==='POSITION')positions=values;else attrs[k]=world.accessor(values,src.width);}
    world.addMesh('TeaHouseEntrancePlanter',positions,p.material,{noGround:true},attrs);
  }
}
assert.equal(changes.relocatedPlanterTriangles,32);assert.equal(changes.removedCafeTriangles,284);
const structure=fs.readFileSync(path.join(ROOT,'docs/procedural-city/tea-house/proposed-structure.glb'));
world.append(structure);
const collision=edit(baseline('world-city3-collision.glb'));
for(const n of collision.doc.nodes){if(n.name!=='col_heroes')continue;for(const p of collision.doc.meshes[n.mesh].primitives)changes.removed.col_heroes=collision.filter(n,p,ps=>{const q=local(ps);return inHouse(q)||q.every(([u,y,d])=>u>=13.27&&u<=15.89&&d>=-.851&&d<=.001&&y<=.49)});}
// Subtract the lift pit from the original large ground triangles rather than deleting the island's floor.
function clip(poly,axis,k,inside){const result=[];for(let i=0;i<poly.length;i++){const a=poly[i],b=poly[(i+1)%poly.length],ai=inside(a[axis]-k),bi=inside(b[axis]-k);if(ai)result.push(a);if(ai!==bi){const t=(k-a[axis])/(b[axis]-a[axis]);result.push(a.map((x,j)=>x+(b[j]-x)*t));}}return result;}
for(const n of collision.doc.nodes){if(n.name!=='col_ground')continue;for(const p of collision.doc.meshes[n.mesh].primitives){const positions=[];const indices=collision.indices(p);for(let i=0;i<indices.length;i+=3){let inner=collision.points(p,indices.slice(i,i+3));const pieces=[];for(const[axis,k,side]of [[0,-20.5,1],[0,-17.8,-1],[2,-84.2,1],[2,-81,-1]]){const outside=clip(inner,axis,k,x=>x*side<0);if(outside.length>=3)pieces.push(outside);inner=clip(inner,axis,k,x=>x*side>=0);if(inner.length<3)break;}for(const polygon of pieces)for(let j=1;j<polygon.length-1;j++)positions.push(...polygon[0],...polygon[j],...polygon[j+1]);}p.attributes={POSITION:collision.accessor(positions,3)};delete p.indices;}}
collision.append(structure,{collision:true});
// Lift leaves were merged into structural lift groups in the study. Split only their panel triangles.
for(const [target,isCollision] of [[world,false],[collision,true]]){
  for(const n of [...target.doc.nodes]){
    if(n.mesh===undefined||!n.name.endsWith('_lift'))continue;
    const level=n.name.match(/(?:^|_)(G|L[123])_lift$/)?.[1];if(!level)continue;
    const floor=level==='G'?.48:4.4+(Number(level[1])-1)*3.5;
    for(const p of target.doc.meshes[n.mesh].primitives){
      const positions=[];
      const removed=target.filter(n,p,ps=>{const yes=ps.every(([u,y,z])=>u>17.78&&u<18.92&&z< -8.525&&z> -8.585&&y>=floor-.001&&y<=floor+2.201);if(yes)positions.push(...ps.flat());return yes;});
      if(removed){assert.equal(removed,24,`Lift panel split ${level}`);const v=target.addMesh(`${isCollision?'col_':''}TeaLiftDoor_${level}`,positions,p.material,{elevatorDoor:true,noGround:true});const added=target.doc.nodes.at(-1);added.translation=[-37.5,0,-72.5];}
    }
  }
}

// Close the 10 cm ground-to-slab gap, while preserving the reserved lift pit.
const plinthMat=world.doc.materials.findIndex(m=>m.name==='Structure_slab');
for(const [i,r]of [[-37.5,-84.5,-20.5,-72.5],[-17.8,-84.5,-12.5,-72.5],[-20.5,-84.5,-17.8,-84.2],[-20.5,-81,-17.8,-72.5]].entries()){
  world.box(`TeaPlinth_${i}`,r,.12,.3,plinthMat,{building:'tea',noGround:false});collision.box(`col_tea_plinth_${i}`,r,.12,.3,0,{noGround:false});
}
const glassMat=world.doc.materials.length;world.doc.materials.push({name:'TeaHouseGlass',doubleSided:true,alphaMode:'BLEND',pbrMetallicRoughness:{baseColorFactor:[.40,.62,.68,.24],roughnessFactor:.22,metallicFactor:0}});
const collisionMat=0;
for(let level=0;level<4;level++)for(let k=0;k<6;k++){
  if(level===0&&[0,3,5].includes(k))continue;const floor=level===0?.48:4.4+(level-1)*3.5,c=(k+.5)*25/6,w=level===0?2.9:level===2?1.25:1.2916667,lo=level===0?1.05:floor+(level===2?.95:.15),hi=level===0?3.3:lo+1.62;
  const rect=[c-w/2-37.5,-72.68,c+w/2-37.5,-72.66];world.box(`TeaGlass_L${level}_${k}`,rect,lo,hi,glassMat,{noGround:true,level:level===0?'G':`L${level}`,building:'tea'});collision.box(`col_tea_glass_L${level}_${k}`,rect,lo,hi,collisionMat,{noGround:true});
}
collision.box('col_tea_entrance_planter',[-31.74,-72.19,-30.76,-71.21],.2,1.5,collisionMat,{noGround:true});
world.write(path.join(out,'world-city3.glb'));collision.write(path.join(out,'world-city3-collision.glb'));
// Keep a light ground layout: four sparse bottle displays and the radio's table. Every other old fitting is removed.
const oldTea=JSON.parse(baseline('interiors/tea.json'));
const props=[];
for(const[from,to]of [[4,5.4],[6,7.4],[8,9.4],[10,11.4]]){
  const bottles=oldTea.props.filter(([name,x,,z])=>name.startsWith('bottle_')&&Math.abs(x+37.5-from)<.95&&Math.abs(z+83.79)<.01);
  const rows=new Map();for(const p of bottles){const list=rows.get(p[2])??[];list.push(p);rows.set(p[2],list);}
  for(const row of rows.values())for(const p of row.filter((_,i)=>i%3===0).slice(0,4))props.push([p[0],+(p[1]+to-from).toFixed(3),...p.slice(2)]);
}
props.push(['CashRegister_01',-30.8,1.6,-81.35,Math.PI,1],['table_round',-21.5,.48,-75.9,0,1]);
fs.writeFileSync(path.join(out,'interiors/tea.json'),JSON.stringify({id:'tea',library:'world-city3-library.glb',props}));
fs.writeFileSync(path.join(out,'interiors/tea.col.json'),JSON.stringify({id:'tea',floorY:.48,boxes:[[-21.5,-75.9,.46,.437,.48,1.34,0]],seats:[]}));
const index=JSON.parse(baseline('interiors/index.json')),tea=index.find(r=>r.id==='tea');tea.cut.y=2.58;tea.floors=[.48,4.4,7.9,11.4];
Object.assign(tea.interactables[0],{pos:[-21.04,1.26,-75.9],stand:[-20.55,-75.9]});
fs.writeFileSync(path.join(out,'interiors/index.json'),JSON.stringify(index));
let anchors=JSON.parse(baseline('city3-anchors.json'));if(Array.isArray(anchors))anchors=anchors.filter(a=>a.building!=='tea');else if(Array.isArray(anchors.anchors))anchors.anchors=anchors.anchors.filter(a=>a.building!=='tea');fs.writeFileSync(path.join(out,'city3-anchors.json'),JSON.stringify(anchors));
changes.runtimeSha256=sha(fs.readFileSync(path.join(out,'world-city3.glb')));changes.bottles=props.filter(p=>p[0].startsWith('bottle_')).length;
fs.writeFileSync(path.join(out,'tea-building.json'),JSON.stringify({version:1,origin:[-37.5,0,-72.5],floorHeights:[.48,4.4,7.9,11.4],elevator:'runtime-controlled',...changes},null,2)+'\n');
console.log(JSON.stringify(changes,null,2));
