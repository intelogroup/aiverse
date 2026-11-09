// Interior leaves are authored at their open pose in blockout.py. Fit hardware to that pose.
const palettes={
  G: {body:[.24,.38,.30],panel:[.30,.44,.34],edge:[.13,.25,.19]},
  L1:{body:[.52,.34,.17],panel:[.64,.47,.27],edge:[.34,.22,.11]},
  L2:{body:[.39,.21,.13],panel:[.52,.31,.20],edge:[.25,.13,.08]},
  L3:{body:[.20,.32,.41],panel:[.28,.39,.46],edge:[.13,.22,.28]},
};

export function finishTeaDoors(level,{batch,material,wood,finishSurface,node,addHardware}){
  const {id,floorY:y}=level,palette=palettes[id];
  const body=material(id+'_door_wood',palette.body,wood);
  const panel=material(id+'_door_inset',palette.panel);
  const edge=material(id+'_door_moulding',palette.edge);
  const brass=material(id+'_door_satin_brass',[.52,.33,.15],undefined,undefined,{metallicFactor:.58,roughnessFactor:.32});
  finishSurface(node,body);
  const panels=[],mouldings=[];
  for(const entry of level.doors.filter(d=>d.mode==='hinged')){
    const room=level.rooms.find(r=>r.id===entry.opensInto);
    const direction=room.rect[entry.axis==='d'?1:0]>=entry.at-1e-6?1:-1;
    const hinge=entry.center+(entry.hinge==='high'?1:-1)*entry.width/2;
    const low=entry.hinge==='high'?hinge-.045:hinge,high=low+.045;
    const face=(normal,start,end,h0,h1,depth)=>{
      const [a,b]=[entry.at+direction*start,entry.at+direction*end].sort((a,b)=>a-b);
      const [n0,n1]=[normal,normal+depth].sort((a,b)=>a-b);
      return entry.axis==='d'?[n0,a,n1,b,y+h0,y+h1]:[a,n0,b,n1,y+h0,y+h1];
    };
    for(const side of [-1,1]){
      const normal=side<0?low:high;
      const end=entry.width-.18;
      for(const [bottom,top] of [[.23,.86],[1.11,2.02]]){
        panels.push(face(normal,.145,end,bottom,top,side*.004));
        for(const p of [.145,end])mouldings.push(face(normal,p-.013,p+.013,bottom,top,side*.010));
        for(const h of [bottom,top])mouldings.push(face(normal,.132,end+.013,h-.012,h+.012,side*.010));
      }
      const latch=entry.at+direction*(entry.width-.095);
      addHardware(id+'_knob_'+entry.b+(side<0?'_back':'_front'),entry.axis,normal,latch,y+1.01,side,brass);
    }
  }
  batch(id+'_door_panels',panels,panel);
  batch(id+'_door_beading',mouldings,edge);
}
