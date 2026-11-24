/** One lease shared by Goals, Automations and Knowledge AI. Foreground work
 * retains priority; workers retry admission later without creating failures. */
export class BackgroundAdmission {
  private holder?:string;
  constructor(readonly foregroundBusy:()=>boolean){}
  acquire(owner:string):(()=>void)|undefined {
    if(this.holder||this.foregroundBusy())return;
    this.holder=owner;let released=false;
    return ()=>{if(!released){released=true;if(this.holder===owner)this.holder=undefined;}};
  }
  canContinue(owner:string){return this.holder===owner&&!this.foregroundBusy();}
}

/** True while an agent produced an event within the last ten minutes (or its activity is unknown). */
export function recentlyActive(agent:any,now=Date.now(),windowMs=10*60_000):boolean{const last=agent?.session?.snapshotEvents?.()?.at?.(-1)?.time;return typeof last!=="number"||now-last<windowMs;}
