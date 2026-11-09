import {StrictMode} from 'react';
import {render,fireEvent,screen} from '@testing-library/react';
import {expect,it,vi} from 'vitest';
import * as T from 'three';
import {TeaElevatorController,LIFT} from './teaElevator';
import {WalkColliders} from './walkColliders';
import {makeWalker} from './walker';
const fixture=vi.hoisted(()=>({scene:null as unknown as T.Scene,resident:null as unknown as T.Group}));
vi.mock('@react-three/fiber',()=>({useFrame:()=>{},useThree:(select:(s:{scene:T.Scene})=>unknown)=>select({scene:fixture.scene})}));
vi.mock('@react-three/drei',()=>({useGLTF:()=>({scene:fixture.resident})}));
import {TeaElevator,TeaElevatorHud} from './TeaElevatorView';
it('keeps riders through StrictMode remount and restores protected landings on final unmount',async()=>{
 fixture.scene=new T.Scene();fixture.resident=new T.Group();fixture.scene.add(fixture.resident);
 const leaves=Array.from({length:4},(_,i)=>{const m=new T.Mesh(new T.BoxGeometry(1.1,2.2,.05),new T.MeshBasicMaterial());m.position.set(LIFT.x,.48+i*3.5+1.1,LIFT.doorZ);m.userData={elevatorDoor:true,noGround:true};fixture.resident.add(m);return m;});fixture.scene.updateMatrixWorld(true);
 const c=new TeaElevatorController(),walk=new WalkColliders();const s=makeWalker(LIFT.x,.48,-82.1,0);c.observe(s);
 const view=render(<StrictMode><TeaElevator controller={c} walk={walk} url="fixture" /></StrictMode>);await Promise.resolve();
 expect(c.ready).toBe(true);expect(s.z).toBe(-82.1);expect(fixture.scene.children.filter(o=>o.name==='TeaElevator')).toHaveLength(1);expect(walk.has('elevator:dynamic')).toBe(true);expect(leaves.every(m=>!m.visible)).toBe(true);
 view.unmount();await Promise.resolve();expect(c.ready).toBe(false);expect(s.z).toBe(-80.1);expect(walk.has('elevator:dynamic')).toBe(false);expect(walk.has('elevator:safety')).toBe(true);expect(leaves.every(m=>m.visible)).toBe(true);expect(fixture.scene.children.some(o=>o.name==='TeaElevator')).toBe(false);walk.dropAll();leaves.forEach(m=>{m.geometry.dispose();(m.material as T.Material).dispose();});
});

it('offers same-floor hall calls and cabin destinations, and Escape dismisses controls',()=>{
 const c=new TeaElevatorController();c.ready=true;const walk=new WalkColliders();const frame={current:{state:'idle' as const,speed:0,x:LIFT.x,y:.48,z:-80.1}};
 const view=render(<TeaElevatorHud controller={c} walk={walk} frame={frame} walking />);
 fireEvent.click(screen.getByRole('button',{name:'Elevator controls (E)'}));fireEvent.click(screen.getByRole('button',{name:'Call up'}));expect(c.snapshot().pending).toContainEqual({floor:0,direction:1,at:0});
 frame.current={...frame.current,z:-82.1};view.rerender(<TeaElevatorHud controller={c} walk={walk} frame={frame} walking />);
 fireEvent.click(screen.getByRole('button',{name:'Elevator to Third'}));expect(c.snapshot().pending.some(p=>p.floor===3)).toBe(true);
 fireEvent.keyDown(screen.getByRole('button',{name:'Dismiss controls'}),{key:'Escape'});expect(c.panelOpen).toBe(false);expect(screen.getByRole('button',{name:'Elevator controls (E)'})).toBeTruthy();
 frame.current={...frame.current,z:-80.1,y:1.7};view.rerender(<TeaElevatorHud controller={c} walk={walk} frame={frame} walking />);expect(screen.queryByRole('button',{name:'Elevator controls (E)'})).toBeNull();view.unmount();
});
