// Interior finishes. Only the restroom fixtures add new collision blockers.
import { readFileSync } from 'node:fs';
import {fitTeaRestrooms,panelTeaCorridor,finishTeaLobby} from './fit-out.mjs';
import {finishTeaGround} from './finish-ground.mjs';

const finishes = [
  { wall: [.47,.63,.43], wet: [.63,.73,.62], wood: [.48,.27,.13], ceiling: [.88,.82,.65], metal: [.49,.29,.1], light: [1,.80,.52], art: 'landscape', shade: [.97,.82,.55] },
  { wall: [.74,.51,.36], wet: [.66,.70,.65], wood: [.36,.17,.08], ceiling: [.91,.83,.70], metal: [.48,.28,.14], light: [1,.74,.55], art: 'garden', shade: [.93,.70,.47] },
  { wall: [.30,.44,.62], wet: [.55,.64,.71], wood: [.25,.18,.13], ceiling: [.68,.75,.79], metal: [.48,.33,.14], light: [1,.83,.66], art: 'portrait', shade: [.80,.86,.91] },
];

export function finishTeaUpper(world, plan, collision) {
  const {doc}=world;
  const house=doc.nodes.find(node=>node.name==='TeaHouseStructure');
  const roots=doc.scenes[doc.scene??0].nodes;
  const image=name=>{
    const bytes=readFileSync(new URL(`../assets/tea-finishes/${name}.jpg`,import.meta.url));
    const source=doc.images.push({name,bufferView:world.appendView(bytes),mimeType:'image/jpeg'})-1;
    return doc.textures.push({source})-1;
  };
  const plaster=image('plaster'),wood=image('wood');
  const artwork=finishes.map(p=>image(p.art));
  function material(name,color,texture,emissive){
    return doc.materials.push({name,pbrMetallicRoughness:{
      baseColorFactor:[...color,1],roughnessFactor:.82,metallicFactor:0,
      ...(texture===undefined?{}:{baseColorTexture:{index:texture}}),
    },...(emissive?{emissiveFactor:emissive}:{})})-1;
  }
  function underHouse(){
    house.children.push(roots.pop());
  }
  function box(name,u0,d0,u1,d1,y0,y1,mat){
    world.box(name,[u0,-d1,u1,-d0],y0,y1,mat,{noGround:true});
    underHouse();
  }
  function mesh(name,vertices,uv,mat,normal){
    const attrs={TEXCOORD_0:world.accessor(uv,2)};
    if(normal)attrs.NORMAL=world.accessor(uv.flatMap((_,i)=>i%2?[]:normal),3);
    world.addMesh(name,vertices,mat,{noGround:true},attrs);
    underHouse();
  }
  function finishSurface(node,mat,select=()=>true){
    const mesh=doc.meshes[node.mesh];
    mesh.primitives=mesh.primitives.flatMap(primitive=>{
      const vertices=[],uv=[],retained=[];
      const indices=world.indices(primitive);
      for(let i=0;i<indices.length;i+=3){
        const ids=indices.slice(i,i+3),points=world.points(primitive,ids);
        if(!select(points)){retained.push(...ids);continue;}
        const [[ax,ay,az],[bx,by,bz],[cx,cy,cz]]=points;
        const nx=(by-ay)*(cz-az)-(bz-az)*(cy-ay);
        const ny=(bz-az)*(cx-ax)-(bx-ax)*(cz-az);
        const nz=(bx-ax)*(cy-ay)-(by-ay)*(cx-ax);
        for(const [x,y,z] of points){
          vertices.push(x,y,z);
          const horizontal=Math.abs(ny)>Math.max(Math.abs(nx),Math.abs(nz));
          uv.push((Math.abs(nx)>Math.abs(nz)?z:x)*.85,(horizontal?z:y)*.85);
        }
      }
      if(!vertices.length)return [primitive];
      const painted={attributes:{POSITION:world.accessor(vertices,3),TEXCOORD_0:world.accessor(uv,2)},material:mat};
      return retained.length?[{...primitive,indices:world.accessor(retained,1,true)},painted]:[painted];
    });
  }
  const punctual={lights:[]};
  doc.extensions??={};
  doc.extensions.KHR_lights_punctual=punctual;
  doc.extensionsUsed??=[];
  if(!doc.extensionsUsed.includes('KHR_lights_punctual'))doc.extensionsUsed.push('KHR_lights_punctual');
  function addPoint(name,u,d,y,color,intensity,range){
    const index=punctual.lights.push({name,type:'point',color,intensity,range})-1;
    house.children.push(doc.nodes.push({name,translation:[u,y,-d],
      extensions:{KHR_lights_punctual:{light:index}}})-1);
  }
  function batch(name,boxes,mat){
    world.boxBatch(name,boxes.map(([u0,d0,u1,d1,y0,y1])=>[[u0,-d1,u1,-d0],y0,y1]),mat,{noGround:true});
    underHouse();
  }
  finishTeaGround(plan,{box,batch,mesh,image,material,wood,plaster,artwork,finishSurface,addPoint,
    bar:doc.nodes.find(n=>n.name==='G_bar')});
  const tile=image('tile');
  fitTeaRestrooms(world,collision,plan,{box,mesh,image,material,addPoint,house,tile});
  for(const level of plan.levels.slice(0,2)){
    finishTeaLobby(level,{box,mesh,material,plaster,tile,finishSurface,
      wetNode:doc.nodes.find(n=>n.name===level.id+'_wet'),
      liftNode:doc.nodes.find(n=>n.name===level.id+'_lift')});
  }
  function lamp(name,u,d,top,style,metal,shade,light){
    const radius=[.31,.24,.20][style], height=[.37,.26,.20][style], bottom=top-.64;
    box(name+'_stem',u-.014,d-.014,u+.014,d+.014,bottom+height,top,metal);
    const vertices=[],normals=[];
    const segments=24;
    for(let i=0;i<segments;i++){
      const a=i*Math.PI*2/segments,b=(i+1)*Math.PI*2/segments;
      const r=style===0?radius*.75:style===1?radius*.63:radius;
      const p=[u+Math.cos(a)*radius,bottom,-d+Math.sin(a)*radius];
      const q=[u+Math.cos(b)*radius,bottom,-d+Math.sin(b)*radius];
      const s=[u+Math.cos(a)*r,bottom+height,-d+Math.sin(a)*r];
      const t=[u+Math.cos(b)*r,bottom+height,-d+Math.sin(b)*r];
      for(const point of [p,s,q,s,t,q]){
        vertices.push(...point);
        const angle=Math.atan2(point[2]+d,point[0]-u);
        normals.push(Math.cos(angle),0,Math.sin(angle));
      }
      vertices.push(u,bottom,-d,...p,...q);
      normals.push(0,-1,0,0,-1,0,0,-1,0);
    }
    world.addMesh(name,vertices,shade,{noGround:true},{NORMAL:world.accessor(normals,3)});
    underHouse();
    addPoint(name+'_light',u,d,bottom-.09,light,29,6);
  }
  for(const [index,level] of plan.levels.slice(1).entries()){
    const {id,floorY:y}=level,p=finishes[index],top=y+3.32;
    const wall=material(id+'_plaster',p.wall,plaster),wet=material(id+'_wet_plaster',p.wet,plaster);
    const door=material(id+'_door_wood',p.wood,wood),trim=material(id+'_trim',p.wood);
    const ceiling=material(id+'_ceiling',p.ceiling,plaster),metal=material(id+'_brass',p.metal);
    const shade=material(id+'_lamp_shade',p.shade,undefined,p.shade.map(c=>c*.58));
    panelTeaCorridor(level,index,{box,mesh,material,wood,plaster,trim});
    const find=kind=>doc.nodes.find(node=>node.name===`${id}_${kind}`);
    for(const kind of ['partition','stairwall'])finishSurface(find(kind),wall);
    if(index>0)finishSurface(find('wet'),wet);
    finishSurface(find('door'),door);
    finishSurface(find('shell'),wall,points=>[[0,.3],[0,24.7],[2,-.3],[2,-11.7]]
      .some(([axis,value])=>points.every(point=>Math.abs(point[axis]-value)<.001)));

    const rooms=level.rooms.filter(room=>room.kind==='home'||room.kind==='room');
    for(const room of rooms){
      const [u0,d0,u1,d1]=room.rect;
      const x0=u0+.13,x1=u1-.13,z0=-d0-.13,z1=-d1+.13,h=top-.045;
      mesh(`${id}_ceiling_${room.id}`,[x0,h,z0,x0,h,z1,x1,h,z1,x0,h,z0,x1,h,z1,x1,h,z0],
        [x0,z0,x0,z1,x1,z1,x0,z0,x1,z1,x1,z0],ceiling,[0,-1,0]);
      for(const d of [d0+.19,d1-.19])box(`${id}_crown_${room.id}`,u0+.13,d-.025,u1-.13,d+.025,top-.095,top-.043,trim);
    }
    for(const u of [3.2,11.3,19.4])lamp(`${id}_pendant_${u}`,u,2.35,top-.045,index,metal,shade,p.light);
    for(const u of [5.8,15.5])lamp(`${id}_pendant_corridor_${u}`,u,5.05,top,index,metal,shade,p.light);
    for(const [d0,d1] of [[4.36,4.42],[5.68,5.74]]){
      box(id+'_corridor_crown',.5,d0,24.5,d1,top-.09,top,trim);
    }
    for(const u of [2.3,8.5,12.7,19.8,22.8]){
      box(id+'_corridor_batten',u-.045,4.36,u+.045,5.74,top-.10,top,trim);
    }

    // Three pieces occupy the solid corridor bays between room openings.
    for(const [i,x] of [7.05,14.8,22.65].entries()){
      const picture=(index+i)%artwork.length;
      const art=material(id+'_art_'+i,[1,1,1],artwork[picture]);
      const center=y+1.66,halfW=[.49,.49,.38][picture],halfH=[.36,.28,.30][picture],z=-4.344;
      box(id+'_frame_'+i,x-halfW-.045,4.305,x+halfW+.045,4.34,center-halfH-.045,center+halfH+.045,metal);
      const a=[x-halfW,center-halfH,z],b=[x+halfW,center-halfH,z],c=[x+halfW,center+halfH,z],d=[x-halfW,center+halfH,z];
      mesh(id+'_picture_'+i,[...a,...d,...b,...b,...d,...c],[1,1,1,0,0,1,0,1,1,0,0,0],art,[0,0,-1]);
    }

    for(const entry of level.doors.filter(d=>d.a==='corridor'&&d.axis==='d'&&d.at===4.3&&d.mode==='hinged')){
      // The existing open leaves extend into the front rooms from the low hinge.
      const u=entry.center-entry.width/2, near=entry.at-.13, far=entry.at-entry.width+.12;
      for(const x of [u-.012,u+.045]){
        for(const d of [near,far])box(id+'_door_stile',x,d-.015,x+.012,d+.015,y+.19,y+2.02,trim);
        for(const h of [.19,1.06,2.00])box(id+'_door_rail',x,far,x+.012,near,y+h,y+h+.023,trim);
        box(id+'_door_handle',x-.022,far-.015,x+.035,far+.10,y+.98,y+1.015,metal);
      }
    }
  }
}
