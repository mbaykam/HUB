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
