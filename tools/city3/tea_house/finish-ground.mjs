import {quad} from './fit-out.mjs';

export function finishTeaGround(plan,{box,batch,mesh,image,material,wood,plaster,artwork,finishSurface,addPoint,bar}){
  const y=plan.levels[0].floorY;
  const walnut=material('G_bar_walnut',[.37,.22,.12],wood);
  const dark=material('G_bar_shadow',[.20,.12,.071]);
  const oak=material('G_bar_reeding',[.31,.17,.085]);
  const brass=material('G_bar_brass',[.51,.34,.14]);
  const soapstone=material('G_bar_soapstone',[.095,.15,.12]);
  const backdrop=material('G_bar_green_plaster',[.14,.23,.17],plaster);
  const fixture=material('G_tea_pendant_housing',[.055,.066,.059]);
  const diffuser=material('G_tea_pendant_diffuser',[.92,.75,.51],undefined,[.8,.54,.25]);
  const runner=material('G_tea_runner',[.83,.83,.83],image('tea-runner'));
  const sign=material('G_tea_bar_lettering',[1,1,1],image('tea-bar-sign'));
  const print=material('G_tea_seating_print',[1,1,1],artwork[0]);
  finishSurface(bar,walnut);

  const {counterCentersU,counterHalfWidth,shelfCentersU}=plan.proposal;
  const left=counterCentersU[0]-counterHalfWidth,right=counterCentersU.at(-1)+counterHalfWidth;
  box('G_tea_bar_plinth',left,8.251,right,8.28,y+.025,y+.13,dark);
  box('G_tea_bar_top',left,8.255,right,9.42,1.584,1.604,soapstone);
  const reeds=[];
  for(const u of counterCentersU){
    const l=u-counterHalfWidth+.045,r=u+counterHalfWidth-.045;
    box('G_tea_counter_inset',l,8.253,r,8.281,y+.15,1.47,dark);
    for(let i=0;i<15;i++){
      const x=l+.035+i*(r-l-.07)/14;
      reeds.push([x-.022,8.229,x+.022,8.253,y+.17,1.45]);
    }
    box('G_tea_counter_brass',l,8.222,r,8.253,1.45,1.472,brass);
  }
  batch('G_tea_counter_reeding',reeds,oak);
  for(const u of shelfCentersU){
    for(const x of [u-.98,u+.98])box('G_tea_shelf_stile',x-.022,10.95,x+.022,11.56,1.60,3.45,dark);
    for(const h of [1.63,2.33,3.03]){
      box('G_tea_shelf_edge',u-.97,10.931,u+.97,10.959,h-.045,h-.014,brass);
    }
  }
  const wallZ=-11.58;
  quad(mesh,'G_tea_bar_backdrop',[4.35,y+.02,wallZ],[12.46,y+.02,wallZ],[12.46,4.18,wallZ],[4.35,4.18,wallZ],
    backdrop,[0,0,1],[5,2]);
  box('G_tea_linear_pendant',5.72,8.52,11.35,8.62,3.36,3.44,fixture);
  box('G_tea_linear_diffuser',5.77,8.535,11.30,8.605,3.347,3.361,diffuser);
  for(const u of [6.1,10.95])box('G_tea_pendant_stem',u-.008,8.56,u+.008,8.58,3.44,4.22,fixture);
  for(const u of [6.8,10.3])addPoint('G_tea_counter_light_'+u,u,8.58,3.23,[1,.76,.48],20,4.8);

  const [l,r,d,bottom,top]=[6.89,10.15,11.52,3.49,4.06];
  box('G_tea_bar_sign_frame',l-.025,d,r+.025,d+.04,bottom-.025,top+.025,brass);
  quad(mesh,'G_tea_bar_sign',[l,bottom,-d+.008],[r,bottom,-d+.008],[r,top,-d+.008],[l,top,-d+.008],sign,[0,0,1]);

  // The woven runner sits under both tables as one seating zone.
  const z0=-2.13,z1=-4.09,x0=3.62,x1=11.02,h=y+.007;
  quad(mesh,'G_tea_seating_runner',[x0,h,z0],[x1,h,z0],[x1,h,z1],[x0,h,z1],runner,[0,1,0]);

  // A print on the seating side of the west partition, clear of its opening.
  const x=2.233,d0=1.12,d1=2.21,h0=1.62,h1=2.39;
  box('G_tea_seating_frame',x-.017,d0-.03,x,d1+.03,h0-.03,h1+.03,oak);
  quad(mesh,'G_tea_seating_picture',[x+.004,h0,-d0],[x+.004,h0,-d1],[x+.004,h1,-d1],[x+.004,h1,-d0],print,[1,0,0]);
}
