import { TEA_FLOORS } from './teaBuilding';
import type { WalkerState } from './walker';
export const LIFT = { x: -19.15, front: -81.12, back: -83.22, halfWidth: .8, doorZ: -81.04, doorWidth: 1.1 } as const;
export type LiftPhase = 'idle'|'opening'|'open'|'closing'|'moving'|'leveling'|'unavailable';
export type LiftDirection = -1|0|1;
type Call = { floor:number; direction:LiftDirection; at:number };
type Actor = { state:WalkerState; seen:number; supportY:number|null };
export class TeaElevatorController {
  panelOpen=false; ready=false; phase:LiftPhase='idle'; y:number=TEA_FLOORS[0].y; velocity=0; floor=0; target=0; door=0; direction:LiftDirection=0; now=0; dwell=0; held=false; fault='';
  private actors=new Map<WalkerState,Actor>(); private calls:Call[]=[];
  private trip:{start:number; distance:number; sign:number; time:number; accelTime:number; cruise:number; peak:number}|null=null;
  readonly transitions:{time:number;phase:LiftPhase}[]=[];
  snapshot(){return {ready:this.ready,phase:this.phase,y:this.y,velocity:this.velocity,floor:this.floor,target:this.target,door:this.door,direction:this.direction,pending:this.calls.map(c=>({...c})),obstructed:this.obstructed(),passengers:[...this.actors.values()].filter(a=>a.supportY!==null).length,fault:this.fault};}
  private set(phase:LiftPhase){this.phase=phase;this.transitions.push({time:this.now,phase});if(this.transitions.length>64)this.transitions.shift();}
  valid(f:number){return Number.isInteger(f)&&f>=0&&f<TEA_FLOORS.length;}
  aligned(){return Math.abs(this.y-TEA_FLOORS[this.floor].y)<.005&&Math.abs(this.velocity)<.001;}
  canPass(f:number){return this.ready&&f===this.floor&&this.aligned()&&this.door>.97&&(this.phase==='open'||this.phase==='opening'||this.phase==='unavailable');}
  call(f:number,direction:LiftDirection=0){
    if(!this.ready||this.phase==='unavailable'||!this.valid(f)||![-1,0,1].includes(direction)||(f===0&&direction<0)||(f===3&&direction>0))return false;
    if(!this.calls.some(c=>c.floor===f&&c.direction===direction))this.calls.push({floor:f,direction,at:this.now});
    if(this.aligned()&&f===this.floor&&!['moving','leveling'].includes(this.phase)){this.dwell=0;if(this.phase!=='open')this.set('opening');}
    return true;
  }
  open(){if(this.ready&&this.aligned()&&this.phase!=='unavailable'){this.dwell=0;this.set('opening');return true;}return false;}
  close(){if(this.phase==='open'&&this.dwell>=1&&!this.obstructed()&&!this.held)this.set('closing');}
  inside(s:Pick<WalkerState,'x'|'z'>){return Math.abs(s.x-LIFT.x)<=LIFT.halfWidth-.38&&s.z<LIFT.front-.40&&s.z>LIFT.back+.38;}
  access(s:{x:number;y:number;z:number}):'cabin'|number|null{
    if(this.inside(s)&&Math.abs(s.y-this.y)<.2)return 'cabin';
    if(Math.abs(s.x-LIFT.x)>1.35||s.z< -80.7||s.z> -79.1)return null;
    const f=TEA_FLOORS.findIndex(f=>Math.abs(f.y-s.y)<.2);return f<0?null:f;
  }
  private withinFloor(s:WalkerState){return Math.abs(s.y-this.y)<.16;}
  observe(s:WalkerState){
    if(!this.actors.has(s)&&(Math.abs(s.x-LIFT.x)>2||s.z> -79||s.z< -84))return;
    let a=this.actors.get(s);if(!a){a={state:s,seen:this.now,supportY:null};this.actors.set(s,a);}a.seen=this.now;
    if(this.inside(s)&&this.withinFloor(s))a.supportY=this.y;
    else if(!this.inside(s))a.supportY=null;
  }
  prepare(s:WalkerState){const a=this.actors.get(s);if(a?.supportY!==null&&a?.supportY!==undefined){s.y+=this.y-a.supportY;s.vy=0;s.grounded=true;a.supportY=this.y;}this.observe(s);}
  forget(s:WalkerState){this.actors.delete(s);}
  overCapacity(){return [...this.actors.values()].filter(a=>a.supportY!==null).length>2;}
  obstructed(){return this.overCapacity()||[...this.actors.values()].some(({state:s})=>Math.abs(s.y-this.y)<1.8&&Math.abs(s.x-LIFT.x)<.95&&s.z>LIFT.front-.46&&s.z<LIFT.doorZ+.48);}
  private choose(){
    const oldest=this.calls.reduce<Call|null>((a,c)=>!a||c.at<a.at?c:a,null);
    if(oldest&&this.now-oldest.at>30)return oldest.floor;
    const ahead=this.calls.filter(c=>(c.floor-this.floor)*this.direction>0&&(c.direction===0||c.direction===this.direction));
    const choices=ahead.length?ahead:this.calls;
    return [...choices].sort((a,b)=>Math.abs(a.floor-this.floor)-Math.abs(b.floor-this.floor)||a.at-b.at)[0]?.floor;
  }
  private dispatch(){const next=this.choose();if(next===undefined){this.direction=0;this.set('idle');return;}
    if(next===this.floor){this.direction=this.calls.find(c=>c.floor===next)?.direction??0;this.set('opening');return;}
    this.target=next;this.direction=Math.sign(next-this.floor) as LiftDirection;
    const distance=Math.abs(TEA_FLOORS[next].y-this.y),accelTime=Math.min(1.2/.8,Math.sqrt(distance/.8)),peak=.8*accelTime;
    this.trip={start:this.y,distance,sign:this.direction,time:0,accelTime,cruise:Math.max(0,(distance-peak*accelTime)/peak),peak};this.set('moving');
  }
  tick(dt:number){if(!this.ready||!Number.isFinite(dt)||dt<=0)return;let remaining=Math.min(dt,.1);while(remaining>1e-8){const h=Math.min(remaining,1/60);this.advance(h);remaining-=h;}}
  private advance(dt:number){
    this.now+=dt;
    for(const[s,a]of this.actors)if(this.now-a.seen>1){this.actors.delete(s);}
    if(this.phase==='unavailable')return;
    if(this.phase==='idle'){if(this.calls.length)this.dispatch();return;}
    if(this.phase==='opening'){
      this.door=Math.min(1,this.door+dt/1.5);if(this.door===1){this.dwell=0;this.calls=this.calls.filter(c=>c.floor!==this.floor||(c.direction!==0&&this.direction!==0&&c.direction!==this.direction));this.set('open');}return;
    }
    if(this.phase==='open'){if(this.obstructed()||this.held)this.dwell=0;else this.dwell+=dt;if(this.dwell>=4)this.set('closing');return;}
    if(this.phase==='closing'){
      if(this.obstructed()||this.held){this.set('opening');return;}
      this.door=Math.max(0,this.door-dt/1.5);if(this.door===0)this.dispatch();return;
    }
    const t=this.trip;if(!t||this.door!==0){this.fail('Invalid departure interlock');return;}
    t.time+=dt;const total=2*t.accelTime+t.cruise,u=Math.min(t.time,total);let d:number;
    if(u<t.accelTime){d=.4*u*u;this.velocity=t.sign*.8*u;}
    else if(u<t.accelTime+t.cruise){d=.5*t.peak*t.accelTime+t.peak*(u-t.accelTime);this.velocity=t.sign*t.peak;}
    else {const left=total-u;d=t.distance-.4*left*left;this.velocity=t.sign*.8*left;this.phase='leveling';}
    this.y=t.start+t.sign*d;
    if(u===total){this.y=TEA_FLOORS[this.target].y;this.velocity=0;this.floor=this.target;this.trip=null;this.set('opening');}
  }
  fail(message:string){const level=this.aligned();this.velocity=0;this.door=level?1:0;this.fault=message;this.set('unavailable');}
  /** Explicit exceptional recovery. Caller checks the exit landing is free before enabling it. */
  recover(canExit:(x:number,y:number,z:number)=>boolean){
    if(this.phase!=='unavailable')return false;
    const stop=TEA_FLOORS.reduce((best,f,i)=>Math.abs(f.y-this.y)<Math.abs(TEA_FLOORS[best].y-this.y)?i:best,0);
    const riders=[...this.actors.values()].filter(a=>a.supportY!==null);
    const exits=riders.map((_,i)=>({x:LIFT.x+(i-(riders.length-1)/2)*.9,y:TEA_FLOORS[stop].y,z:-80.1}));
    if(exits.some(e=>!canExit(e.x,e.y,e.z)))return false;
    this.floor=stop;this.y=TEA_FLOORS[stop].y;this.velocity=0;this.trip=null;this.calls=[];this.door=0;
    riders.forEach((a,i)=>{Object.assign(a.state,exits[i]);a.state.vx=a.state.vz=a.state.vy=0;a.supportY=null;});
    this.fault='';this.set('opening');return true;
  }
  shutdown(){for(const a of this.actors.values())if(a.supportY!==null){a.state.x=LIFT.x;a.state.z=-80.1;a.state.y=TEA_FLOORS[this.floor].y;a.state.vx=a.state.vz=a.state.vy=0;}this.actors.clear();this.panelOpen=false;this.held=false;this.ready=false;}
}
