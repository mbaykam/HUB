import {readFile} from "node:fs/promises";
import {join,resolve} from "node:path";
import {atomicJson} from "./knowledge-store.ts";
/** Quota is account/provider-wide, not a reason to retry each queued model.
 * All HUB background queues share this durable availability receipt. */
export class ProviderGate {
  private blocked:Record<string,{at:number;message:string}>={};private writing:Promise<unknown>=Promise.resolve();private ready:Promise<void>;
  constructor(readonly root:string){this.ready=(async()=>{try{this.blocked=JSON.parse(await readFile(join(root,"providers.json"),"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}})();void this.ready.catch(()=>{});}
  private async refresh(){try{this.blocked=JSON.parse(await readFile(join(this.root,"providers.json"),"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}}
  async reason(provider:string){await this.ready;await this.writing;await this.refresh();return this.blocked[provider]?.message;}
  private write(fn:()=>void){const p=this.writing.then(async()=>{await this.ready;await this.refresh();fn();await atomicJson(join(this.root,"providers.json"),this.blocked);});this.writing=p.catch(()=>{});return p;}
  block(provider:string,message:string){return this.write(()=>{this.blocked[provider]={at:Date.now(),message:message.slice(0,600)};});}
  clear(provider:string){return this.write(()=>{delete this.blocked[provider];});}
}
const gates=new Map<string,ProviderGate>();
export function providerGate(root:string){const path=resolve(root);let gate=gates.get(path);if(!gate){gate=new ProviderGate(path);gates.set(path,gate);}return gate;}
