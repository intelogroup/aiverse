import {readFileSync} from 'node:fs';

export function quad(mesh,name,a,b,c,d,mat,normal,repeat=[1,1]){
  const [u,v]=repeat;
  mesh(name,[...a,...b,...c,...a,...c,...d],[0,v,u,v,u,0,0,v,u,0,0,0],mat,normal);
}

export function panelTeaCorridor(level,style,{box,mesh,material,wood,plaster,trim}){
  const {id,floorY:y}=level;
  const baseColors=[[.38,.22,.10],[.29,.13,.065],[.18,.25,.32]];
  const insertColors=[[.69,.50,.25],[.49,.27,.12],[.37,.46,.50]];
  const base=material(id+'_wainscot',baseColors[style],wood);
  const insert=material(id+'_panel_inset',insertColors[style],style===2?plaster:wood);
  const openings=level.doors.filter(d=>d.axis==='d'&&d.at===4.3)
    .map(d=>[d.center-d.width/2-.12,d.center+d.width/2+.12]).sort((a,b)=>a[0]-b[0]);
  let start=.42;
  for(const [end,next] of [...openings,[24.58,24.58]]){
    if(end-start>.25){
      const z=-4.319;
      quad(mesh,id+'_wainscot_face',[end,y+.07,z],[start,y+.07,z],[start,y+1.10,z],[end,y+1.10,z],base,[0,0,-1],[(end-start)/1.3,1]);
      for(const h of [.06,1.08])box(id+'_wainscot_rail',start,4.305,end,4.345,y+h,y+h+.052,trim);
      const count=Math.max(1,Math.floor((end-start)/(style===0?.54:1.12)));
      const width=(end-start)/count;
      for(let i=0;i<count;i++){
        const l=start+i*width+.065,r=start+(i+1)*width-.065;
        if(r-l<.1)continue;
        const face=-4.325;
        quad(mesh,id+'_panel_field',[r,y+.18,face],[l,y+.18,face],[l,y+.96,face],[r,y+.96,face],insert,[0,0,-1]);
        for(const x of [l,r])box(id+'_panel_stile',x-.015,4.316,x+.015,4.348,y+.14,y+1.01,trim);
        const rails=style===0?[.39,.68]:style===1?[.15,.98]:[.15,.98,.57];
        for(const h of rails)box(id+'_panel_rail',l,4.318,r,4.35,y+h,y+h+.024,trim);
      }
    }
    start=next;
  }
}

export function fitTeaRestrooms(world,collision,plan,{box,mesh,image,material,addPoint,house,tile:tileImage}){
  const models=['toilet','bathroom-sink'].map(name=>{
    const asset=new URL(`../assets/tea-finishes/${name}.glb`,import.meta.url);
    return {name,roots:world.importScene(readFileSync(asset)).roots,used:false};
  });
  const nodes=world.doc.nodes;
  function clone(i){
    const copy={...nodes[i]};
    if(copy.children)copy.children=copy.children.map(clone);
    return nodes.push(copy)-1;
  }
  function place(model,name,u,y,d,scale,sideWall){
    const children=model.used?model.roots.map(clone):model.roots;
    model.used=true;
    house.children.push(nodes.push({name,children,translation:[u,y,-d],scale:[scale,1,scale],...(sideWall?{rotation:[0,-Math.SQRT1_2,0,Math.SQRT1_2]}:{})})-1);
  }
  const tile=material('TeaRestroom_wallTile',[.82,.89,.82],tileImage);
  const floor=material('TeaRestroom_floorTile',[.59,.65,.62],tileImage);
  const groutTrim=material('TeaRestroom_tileCap',[.28,.38,.31]);
  const restroom=material('TeaRestroom_sign',[1,1,1],image('restroom'));
  const bathroom=material('TeaBathroom_sign',[1,1,1],image('bathroom'));
  const restroomShade=material('TeaRestroom_lightShade',[.85,.82,.71],undefined,[.46,.40,.29]);

  for(const level of plan.levels)for(const room of level.rooms){
    if(room.kind!=='wet'||room.id==='pantry')continue;
    const y=level.floorY,id=`${level.id}_${room.id}`;
    const [u0,d0,u1,d1]=room.rect;
    const l=u0+.12,r=u1-.12,f=d0+.12,b=d1-.12;
    const privateBath=room.id.endsWith('-bath');
    const fixtures=privateBath
      ? [[r-.33,d1-.43,.33,.19],[r-.22,d0+.46,.22,.33]]
      : [[u0+.43,b-.33,.19,.33],[u1-.45,b-.22,.33,.22]];
    for(const [i,[u,d,halfU,halfD]] of fixtures.entries()){
      const name=id+(i===0?'_toilet':'_sink');
      place(models[i],name,u,y,d,i===0?1:.78,privateBath);
      collision.box('col_'+name,[u-halfU-37.5,-72.5-d-halfD,u+halfU-37.5,-72.5-d+halfD],
        y,y+(i===0?.81:.89),0,{noGround:true});
    }

    quad(mesh,id+'_floor_tile',[l,y+.008,-f],[r,y+.008,-f],[r,y+.008,-b],[l,y+.008,-b],floor,[0,1,0],[(r-l)/.62,(b-f)/.62]);
    quad(mesh,id+'_splashback',[l,y+.02,-b],[r,y+.02,-b],[r,y+1.19,-b],[l,y+1.19,-b],tile,[0,0,1],[(r-l)/.59,2]);
    box(id+'_tile_cap',l,b-.017,r,b+.013,y+1.18,y+1.23,groutTrim);
    if(privateBath){
      quad(mesh,id+'_side_tile',[r,y+.02,-b],[r,y+.02,-f],[r,y+1.19,-f],[r,y+1.19,-b],tile,[-1,0,0],[(b-f)/.59,2]);
      box(id+'_side_tile_cap',r-.016,f,r+.012,b,y+1.18,y+1.23,groutTrim);
    }
    addPoint(id+'_restroom_light',(l+r)/2,(f+b)/2,y+2.47,[1,.88,.72],18,3);
    box(id+'_restroom_fixture',(l+r)/2-.18,(f+b)/2-.13,(l+r)/2+.18,(f+b)/2+.13,y+2.55,y+2.61,
      restroomShade);

    const entry=level.doors.find(d=>d.b===room.id&&d.mode==='hinged');
    const sign=room.id.endsWith('-bath')?bathroom:restroom;
    const hinge=entry.center-entry.width/2, s=y+1.64, h=.105;
    if(entry.axis==='d'){
      const x=hinge+.048,d=entry.at+entry.width*.53;
      quad(mesh,id+'_door_sign',[x,s-h,-d+.32],[x,s-h,-d-.32],[x,s+h,-d-.32],[x,s+h,-d+.32],sign,[1,0,0]);
      const z=-entry.at+.019,c=entry.center;
      quad(mesh,id+'_header_sign',[c-.36,y+2.31,z],[c+.36,y+2.31,z],[c+.36,y+2.52,z],[c-.36,y+2.52,z],sign,[0,0,1]);
    }else{
      const x=entry.at+entry.width*.53,z=-hinge-.048;
      quad(mesh,id+'_door_sign',[x+.32,s-h,z],[x-.32,s-h,z],[x-.32,s+h,z],[x+.32,s+h,z],sign,[0,0,-1]);
    }
  }
}

const lobbyFinishes={
  G: {lime:[.59,.62,.49],tile:[.43,.55,.43],stone:[.62,.53,.39]},
  L1:{lime:[.59,.62,.49],tile:[.43,.55,.43],stone:[.62,.53,.39]},
  L2:{lime:[.69,.55,.43],tile:[.62,.36,.23],stone:[.64,.49,.35]},
  L3:{lime:[.46,.52,.55],tile:[.29,.44,.51],stone:[.48,.52,.55]},
};

export function finishTeaLobby(level,{box,mesh,material,plaster,tile,finishSurface,wetNode,liftNode}){
  const {id,floorY:y}=level;
  const palette=lobbyFinishes[id];
  const lime=material(id+'_restroom_limewash',palette.lime,plaster);
  const ceramic=material(id+'_restroom_lobby_ceramic',palette.tile,tile);
  const stone=material(id+'_lift_lobby_stone',palette.stone,plaster);
  const jamb=material(id+'_lift_bronze_trim',[.24,.17,.10]);
  finishSurface(wetNode,lime,points=>points.every(([u,,z])=>u>=12.69&&z<=-8.49));
  finishSurface(liftNode,stone,points=>!points.every(([u,h,z])=>
    u>17.78&&u<18.92&&z< -8.525&&z> -8.585&&h>=y-.001&&h<=y+2.201));

  // The facing is broken at both restroom openings. The door leaves and call controls
  // retain their own geometry and are outside these visual-only trim strips.
  for(const [l,r] of [[12.91,13.33],[14.47,15.28],[16.32,16.54]]){
    const z=-8.476;
    quad(mesh,id+'_restroom_lobby_tile',[l,y+.08,z],[r,y+.08,z],[r,y+1.12,z],[l,y+1.12,z],
      ceramic,[0,0,1],[(r-l)/.46,2]);
    box(id+'_restroom_lobby_cap',l,8.457,r,8.486,y+1.09,y+1.135,jamb);
  }
  for(const u of [17.73,18.97]){
    box(id+'_lift_jamb',u-.035,8.463,u+.035,8.511,y+.03,y+2.3,jamb);
  }
  box(id+'_lift_lintel',17.695,8.463,19.005,8.511,y+2.255,y+2.32,jamb);
}
