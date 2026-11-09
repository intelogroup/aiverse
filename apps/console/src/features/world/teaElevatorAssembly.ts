import * as THREE from 'three';
import { boxesMesh, NO_GROUND } from './capsuleWorld';
import { TEA_FLOORS } from './teaBuilding';
import { LIFT, type TeaElevatorController } from './teaElevator';
/** Dynamic geometry is also the collider source: dimensions cannot drift between the two. */
export function createTeaElevatorAssembly() {
  const root=new THREE.Group();root.name='TeaElevator';
  const colliders:THREE.Mesh[]=[];const moving:{visual:THREE.Mesh|null;collider:THREE.Mesh;floor:number|null;side:number;gate:boolean}[]=[];
  const materials=[new THREE.MeshStandardMaterial({color:'#647b80',roughness:.55}),new THREE.MeshStandardMaterial({color:'#b8a17b',roughness:.7}),new THREE.MeshStandardMaterial({color:'#e5e0c8',roughness:.7}),new THREE.MeshStandardMaterial({color:'#2fae99',emissive:'#153c32',emissiveIntensity:.6})];
  materials.push(materials[2].clone(),materials[3].clone());materials[4].userData.noCutaway=true;materials[5].userData.noCutaway=true;
  function box(name:string,x:number,z:number,w:number,d:number,lo:number,hi:number,mat:number,ground=false,floor:number|null=null,side=0,gate=false){
    const collider=boxesMesh([[x,z,w/2,d/2,lo,hi,0]],[0,0],name)!;
    collider.geometry.computeBoundingBox();
    collider.userData[NO_GROUND]=!ground;collider.userData.collisionOffset=new THREE.Vector3();colliders.push(collider);
    let visual:THREE.Mesh|null=null;
    if(!gate){visual=new THREE.Mesh(new THREE.BoxGeometry(w,hi-lo,d),materials[mat]);visual.position.set(x,(lo+hi)/2,z);visual.name=name;root.add(visual);}
    moving.push({visual,collider,floor,side,gate});return visual;
  }
  // All car coordinates are relative to the moving feet datum, using fixed world X/Z.
  box('CabinFloor',LIFT.x,(LIFT.front+LIFT.back)/2,1.8,2.3,-.14,0,1,true);
  box('CabinRear',LIFT.x,LIFT.back-.05,1.8,.1,0,2.2,0);
  for(const side of [-1,1]){
    box('CabinSide',LIFT.x+side*.85,(LIFT.front+LIFT.back)/2,.1,2.2,0,2.2,0);
    box('CabinFrontJamb',LIFT.x+side*.69,LIFT.front,.28,.08,0,2.2,0);
    box('CabinDoor',LIFT.x+side*.275,LIFT.front,.55,.05,0,2.2,0,false,null,side);
  }
  box('CabinCeiling',LIFT.x,(LIFT.front+LIFT.back)/2,1.8,2.3,2.2,2.28,4);
  box('CabinLight',LIFT.x,(LIFT.front+LIFT.back)/2,.7,.65,2.17,2.2,5);
  box('CabinPanel',LIFT.x+.77,LIFT.front-.65,.04,.3,.9,1.4,3);
  box('CabinGate',LIFT.x,LIFT.front,1.1,.08,0,2.2,0,false,null,0,true);
  for(const i of TEA_FLOORS.keys()){
    box(`LandingSill${i}`,LIFT.x,-81.04,1.1,.32,-.12,0,1,true,i);
    for(const side of [-1,1])box(`LandingDoor${i}`,LIFT.x+side*.275,LIFT.doorZ,.55,.05,0,2.2,0,false,i,side);
    box(`LandingGate${i}`,LIFT.x,LIFT.doorZ,1.1,.10,0,2.2,0,false,i,0,true);
    box(`CallPanel${i}`,LIFT.x+.71,-80.88,.16,.04,1.0,1.3,3,false,i);
  }
  function update(c:TeaElevatorController){
    for(const m of moving){const y=m.floor===null?c.y:TEA_FLOORS[m.floor].y;const fraction=m.floor===null||m.floor===c.floor&&c.aligned()?c.door:0;const x=m.side*fraction*.57;
      const offset=m.collider.userData.collisionOffset as THREE.Vector3;offset.set(x,y,0);
      m.collider.userData.collisionDisabled=m.gate&&c.canPass(m.floor??c.floor);
      if(m.visual){m.visual.position.x=(m.collider.geometry.boundingBox?.getCenter(new THREE.Vector3()).x??0)+x;m.visual.position.y=(m.collider.geometry.boundingBox!.min.y+m.collider.geometry.boundingBox!.max.y)/2+y;}
    }root.updateMatrixWorld(true);
  }
  function dispose(){for(const m of colliders){m.geometry.dispose();}root.traverse(o=>{if((o as THREE.Mesh).isMesh)(o as THREE.Mesh).geometry.dispose();});materials.forEach(m=>m.dispose());}
  return {root,colliders,update,dispose};
}
