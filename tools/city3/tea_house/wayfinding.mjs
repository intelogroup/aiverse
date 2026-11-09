const labels={
  G:'ELEVATOR  ·  G',L1:'ELEVATOR  ·  1',L2:'ELEVATOR  ·  2',L3:'ELEVATOR  ·  3',
  'stair-a':'STAIR A  ·  ↓ EXIT','stair-b':'STAIR B  ·  ↓ EXIT',
  'ground-stair-a':'STAIR A  ·  ↑ FLOORS','ground-stair-b':'STAIR B  ·  ↑ FLOORS',
  'left-exit':'EXIT A  ·  TO STREET','right-exit':'EXIT B  ·  TO STREET',
  'exit-directions':'← STAIR A  |  STAIR B →','street-directions':'← EXIT A  |  EXIT B →',
  'core-lobby':'ELEVATOR  /  RESTROOM',
  tasting:'TEA TASTING',salon:'COMMUNITY SALON',reading:'READING LOUNGE',
  pantry:'PANTRY',staff:'STAFF OFFICE','201-living':'201','202-living':'202','203-living':'203',
  '301-living':'301','302-living':'302','303-living':'303',
  laundry:'LAUNDRY',common:'COMMON ROOM',study:'SHARED STUDY',lounge:'RESIDENTS LOUNGE',
  linen:'CLEANING / LINEN','main-exit':'EXIT  ·  TO PLAZA','tea-seating':'TEA ROOM',
};
const keys=Object.keys(labels),cols=4,rows=8;
const cellWidth=512,cellHeight=104;

export function wayfindingSvg(){
  const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;');
  const tiles=keys.map((key,i)=>{
    const x=(i%cols)*cellWidth,y=Math.floor(i/cols)*cellHeight;
    const exit=key.includes('exit')||key==='stair-a'||key==='stair-b'||key==='street-directions';
    return `<g transform="translate(${x} ${y})"><rect width="512" height="104" fill="#242e2c"/><rect x="12" y="10" width="488" height="84" rx="9" fill="${exit?'#235148':'#2b3b37'}" stroke="#c3a76c" stroke-width="3"/><text x="256" y="66" text-anchor="middle" font-family="DejaVu Sans" font-size="${labels[key].length>22?25:33}" font-weight="bold" fill="#fff2d2">${escape(labels[key])}</text></g>`;
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${cols*cellWidth}" height="${rows*cellHeight}">${tiles.join('')}</svg>`;
}

export function addTeaWayfinding(plan,{mesh,material,image}){
  const mat=material('TeaWayfinding',[1,1,1],image('wayfinding'));
  function sign(level,name,key,u,d,y,axis,side,width=.94){
    const i=keys.indexOf(key);
    if(i<0)throw new Error(`Unknown Tea House sign: ${key}`);
    const column=i%cols,row=Math.floor(i/cols);
    const l=(column+8/cellWidth)/cols,r=(column+1-8/cellWidth)/cols;
    const t=(row+7/cellHeight)/rows,b=(row+1-7/cellHeight)/rows;
    const h=width*.084;
    const position=(offset,height)=>axis==='d'
      ?[u+offset*side,height,-d+side*.022]
      :[u+side*.022,height,-d-offset*side];
    const a=position(-width/2,y-h),c=position(width/2,y+h);
    const right=position(width/2,y-h),left=position(-width/2,y+h);
    const normal=axis==='d'?[0,0,side]:[side,0,0];
    mesh(`TeaSign_${level.id}_${name}`,[...a,...right,...c,...a,...c,...left],[l,b,r,b,r,t,l,b,r,t,l,t],mat,normal);
  }
  for(const level of plan.levels){
    const {id,floorY:y}=level;
    const header=(door,key=door.b,side=1,width=.94)=>{
      const [u,d]=door.axis==='d'?[door.center,door.at]:[door.at,door.center];
      sign(level,door.b,key,u,d,y+2.48,door.axis,side,width);
    };
    for(const door of level.doors){
      if(door.b==='lift')header(door,id,1,1.12);
      else if(door.a==='street'&&door.b.endsWith('-exit'))header(door,door.b,-1,1.05);
      else if(door.a==='street'&&door.b==='entry')header(door,'main-exit',-1,1.12);
      else if(id==='G'&&door.b==='stair-b'&&door.axis==='u'){
        sign(level,'stair-b-lobby','ground-stair-b',door.at,door.center,y+2.48,'u',-1,1.08);
      }
      else if(door.b==='stair-a'||(door.b==='stair-b'&&door.axis==='d')){
        header(door,id==='G'?'ground-'+door.b:door.b,1,1.08);
      }else if(door.a==='corridor'&&door.b==='core-lobby'){
        // Both adjoining rooms are circulation. The partition is offset
        // 0.12 m toward the corridor by the architectural blockout.
        sign(level,door.b,door.b,door.center,door.at-.12,y+2.48,'d',1,1.18);
      }else if(door.a==='corridor'&&door.b in labels){
        header(door,door.b,door.at===4.3?-1:1);
      }else if(door.a==='corridor'&&door.b==='rear-west')header(door,id==='L2'?'laundry':'study');
      else if(door.a==='corridor'&&door.b==='rear-east')header(door,id==='L2'?'common':'lounge');
      else if(door.a==='core-lobby'&&door.b==='wc-b'&&id!=='G'&&id!=='L1')header(door,'linen');
      else if(door.a==='left-exit'&&door.b==='tea-seating')header(door,'tea-seating',-1);
    }
    if(id==='G'){
      sign(level,'exit-direction','street-directions',18.35,8.5,y+2.85,'d',1,1.48);
    }else{
      // Above the lobby opening, visible from the main corridor.
      sign(level,'exit-direction','exit-directions',16,5.68,y+2.82,'d',1,1.48);
    }
  }
}
