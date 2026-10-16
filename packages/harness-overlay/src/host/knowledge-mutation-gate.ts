import {AsyncLocalStorage} from "node:async_hooks";
/** Shared admission barrier. Admitted nested writes finish before export;
 * later archive/asset/note/organization mutations wait for the snapshot. */
export class KnowledgeMutationGate {
  private scope=new AsyncLocalStorage<boolean>();
  private active=0;private blocked=false;private idle:(()=>void)[]=[];
  private reopened:Promise<void>=Promise.resolve();private release?:()=>void;
  private snapshots:Promise<unknown>=Promise.resolve();
  async run<T>(task:()=>Promise<T>):Promise<T>{
    if(this.scope.getStore())return task();
    while(this.blocked)await this.reopened;
    this.active++;
    try{return await this.scope.run(true,task);}finally{if(--this.active===0)for(const notify of this.idle.splice(0))notify();}
  }
  snapshot<T>(task:()=>Promise<T>):Promise<T>{
    if(this.scope.getStore())return Promise.reject(Error("Cannot take a Knowledge snapshot from inside a mutation"));
    const next=this.snapshots.then(async()=>{
      this.blocked=true;this.reopened=new Promise(resolve=>{this.release=resolve;});
      try{if(this.active)await new Promise<void>(resolve=>this.idle.push(resolve));return await task();}
      finally{this.blocked=false;this.release?.();this.release=undefined;}
    });this.snapshots=next.catch(()=>{});return next;
  }
}
