import { useFrame, useThree } from '@react-three/fiber';
import { useGLTF } from '@react-three/drei';
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import * as THREE from 'three';
import { createTeaElevatorAssembly } from './teaElevatorAssembly';
import { extendGltf } from './gltfExtensions';
import { type TeaElevatorController } from './teaElevator';
import type { SoundDirector } from './soundDirector';
import { TEA_FLOORS } from './teaBuilding';
import { bakeCollisionParts, createCapsuleWorld } from './capsuleWorld';
import { registerCameraObstacle } from './cameraClearance';
import type { WalkColliders } from './walkColliders';
import type { WalkFrameInfo } from './walkOverride';
export function TeaElevator({controller,walk,url,frame,getDirector}:{controller:TeaElevatorController;walk:WalkColliders;url:string;frame?:RefObject<WalkFrameInfo|null>;getDirector?:()=>SoundDirector|null}) {
  const gl=useThree(s=>s.gl);const resident=useGLTF(url,true,true,extendGltf(gl));const scene=useThree(s=>s.scene);const assembly=useRef<ReturnType<typeof createTeaElevatorAssembly>|null>(null);const generation=useRef(0);const priorPhase=useRef(controller.phase);
  useLayoutEffect(()=>{
    const token=++generation.current;const a=createTeaElevatorAssembly();assembly.current=a;
    const placeholders:THREE.Mesh[]=[];resident.scene.traverse(o=>{if((o as THREE.Mesh).isMesh&&o.userData.elevatorDoor)placeholders.push(o as THREE.Mesh);});
    if(placeholders.length!==4){a.dispose();assembly.current=null;controller.ready=false;controller.fail('Elevator asset mismatch');return;}
    a.update(controller);walk.set('elevator:dynamic',a.colliders);walk.drop('elevator:safety');scene.add(a.root);walk.elevator=controller;controller.ready=true;
    placeholders.forEach(m=>m.visible=false);const unregister=registerCameraObstacle(a.root);
    const debug=new URLSearchParams(location.search).has('walkDebug');if(debug)(window as unknown as Record<string,unknown>).__elevator=controller;
    return ()=>{
      placeholders.forEach(m=>m.visible=true);const safetyRoot=new THREE.Group();for(const m of placeholders){const copy=m.clone();copy.matrixAutoUpdate=false;copy.matrix.copy(m.matrixWorld);safetyRoot.add(copy);}walk.set('elevator:safety',bakeCollisionParts(safetyRoot));
      unregister();scene.remove(a.root);walk.drop('elevator:dynamic');a.dispose();assembly.current=null;
      if(debug)delete (window as unknown as Record<string,unknown>).__elevator;
      queueMicrotask(()=>{if(generation.current===token){controller.shutdown();walk.elevator=undefined;}});
    };
  },[controller,walk,resident.scene,scene]);
  useFrame((_,dt)=>{if(document.hidden)return;controller.tick(dt);assembly.current?.update(controller);
    if(controller.phase==='opening'&&priorPhase.current!==controller.phase){const p=frame?.current;if(p?.x!==undefined&&p.y!==undefined&&p.z!==undefined&&controller.access({x:p.x,y:p.y,z:p.z})!==null)getDirector?.()?.elevatorChime();}
    priorPhase.current=controller.phase;
  },-2);
  return null;
}
export function TeaElevatorHud({controller,frame,walking,walk}:{controller:TeaElevatorController;frame:RefObject<WalkFrameInfo|null>;walking:boolean;walk:WalkColliders}){
  const [,refresh]=useState(0);useEffect(()=>{if(!walking)return;const id=setInterval(()=>refresh(n=>n+1),100);return()=>clearInterval(id);},[walking]);
  const p=frame.current;if(!walking||p?.x===undefined||p.y===undefined||p.z===undefined)return null;
  const access=controller.access({x:p.x,y:p.y,z:p.z});if(access===null)return null;
  const s=controller.snapshot();const pending=(f:number)=>s.pending.some(c=>c.floor===f);
  const act=(f:number)=>access==='cabin'?controller.call(f):controller.call(access);
  const world=createCapsuleWorld(walk.list);
  return <div className="w-lift-hud" onPointerDown={e=>e.stopPropagation()} onKeyDown={e=>{e.stopPropagation();if(e.key==='Escape'){controller.panelOpen=false;controller.held=false;refresh(n=>n+1);}}}>
    <div role="status" aria-live="polite">Elevator · {s.phase==='moving'||s.phase==='leveling'?`${TEA_FLOORS[s.floor].label} → ${TEA_FLOORS[s.target].label}`:TEA_FLOORS[s.floor].label} · {controller.overCapacity()?'Cabin full · two passengers maximum':s.obstructed?'Doorway blocked':s.phase}</div>
    {!controller.panelOpen?<button type="button" onClick={()=>{controller.panelOpen=true;refresh(n=>n+1);}}>Elevator controls (E)</button>:<>
      {s.ready&&s.phase!=='unavailable'?(access==='cabin'?<div role="group" aria-label="Elevator destinations">{TEA_FLOORS.map((f,i)=><button key={f.label} type="button" aria-label={`Elevator to ${f.label}`} aria-pressed={pending(i)} onClick={()=>act(i)}>{i===0?'G':i} · {f.name}</button>)}</div>:<div role="group" aria-label="Call elevator">{access<3&&<button type="button" aria-pressed={s.pending.some(c=>c.floor===access&&c.direction===1)} onClick={()=>controller.call(access,1)}>Call up</button>}{access>0&&<button type="button" aria-pressed={s.pending.some(c=>c.floor===access&&c.direction===-1)} onClick={()=>controller.call(access,-1)}>Call down</button>}</div>):<p>Elevator unavailable · {s.fault}</p>}
      {access==='cabin'&&<div><button type="button" onClick={()=>controller.open()}>Open doors</button><button type="button" onClick={()=>controller.close()}>Close doors</button><button type="button" onPointerDown={e=>{e.currentTarget.setPointerCapture(e.pointerId);controller.held=true;}} onLostPointerCapture={()=>controller.held=false} onPointerUp={()=>controller.held=false} onPointerCancel={()=>controller.held=false} onBlur={()=>controller.held=false} onKeyDown={e=>{if(e.key===' '||e.key==='Enter')controller.held=true;}} onKeyUp={()=>controller.held=false}>Hold open</button></div>}
      {s.phase==='unavailable'&&<button type="button" onClick={()=>controller.recover((x,y,z)=>Math.abs((world.groundY(x,z,y+.1)??Infinity)-y)<.02&&!world.blocked([x,y,z],[x,y,z],.4))}>Return to safe landing</button>}
      <button type="button" onClick={()=>{controller.panelOpen=false;controller.held=false;refresh(n=>n+1);}}>Dismiss controls</button>
      <p>Walk normally · E opens controls · Escape dismisses</p>
    </>}
  </div>;
}
