import {readFile,mkdir,writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {atomicJson} from "./knowledge-store.ts";
import {RESEARCH_LIMITS} from "../research-contract.ts";
import type {HubGoal,GoalEvidence} from "../goal-contract.ts";
export interface ResearchObservation {id:string;kind:"discovery"|"web"|"knowledge";url?:string;title:string;at:number;sha256:string;text:string;partial:boolean;toolCallId:string}
export interface ResearchLedger {version:1;attempts:number;observations:ResearchObservation[];failures:{at:number;operation:string;message:string}[];report?:{markdown:string;at:number;evidence:GoalEvidence;claims:ResearchClaim[];limitations:string[];conflicts:string[]}}
export interface ResearchClaim {text:string;citations:{sourceId:string;quote:string}[];uncertain?:boolean}
const hash=(s:string)=>createHash("sha256").update(s).digest("hex");
export async function readResearch(g:HubGoal):Promise<ResearchLedger>{if(!g.research||!g.workspace)throw Error("Research job unavailable.");try{return JSON.parse(await readFile(join(g.workspace,"research.json"),"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return {version:1,attempts:0,observations:[],failures:[]};}}
export class ResearchEvidence {
  private writes:Promise<unknown>=Promise.resolve();
  constructor(readonly goal:HubGoal){}
  async update<T>(fn:(state:ResearchLedger)=>T|Promise<T>):Promise<T>{const p=this.writes.then(async()=>{const state=await readResearch(this.goal),result=await fn(state);await atomicJson(join(this.goal.workspace!,"research.json"),state);return result;});this.writes=p.catch(()=>{});return p;}
  attempt(operation:string){return this.update(s=>{if(s.attempts>=RESEARCH_LIMITS[this.goal.research!.depth].attempts)throw Error("Research attempt allowance reached. Report partial findings and gaps.");s.attempts++;s.failures=s.failures.slice(-50);return {operation,attempt:s.attempts};});}
  failure(operation:string,message:string){return this.update(s=>{s.failures.push({at:Date.now(),operation,message:message.slice(0,1000)});});}
  observe(value:Omit<ResearchObservation,"id"|"at"|"sha256">){return this.update(s=>{
    const cap=RESEARCH_LIMITS[this.goal.research!.depth];if(s.observations.length>=cap.reads*3||value.kind!=="discovery"&&s.observations.filter(o=>o.kind!=="discovery").length>=cap.reads)throw Error("Source-read allowance reached. Synthesize the observed evidence.");
    if(!value.text.trim())throw Error("The source returned no readable text.");
    const text=value.text.slice(0,24000),item={...value,text,partial:value.partial||value.text.length>text.length,id:"S"+(s.observations.length+1),at:Date.now(),sha256:hash(text)};s.observations.push(item);return item;
  });}
  report(args:any,roundId:string){return this.update(async s=>{
    const claims=validateResearchClaims(args,s),limitations=stringList(args.limitations,"limitations"),conflicts=stringList(args.conflicts,"conflicts");
    const cited=new Set(claims.flatMap(c=>c.citations.map(x=>x.sourceId))),sources=s.observations.filter(o=>cited.has(o.id));
    const markdown=["# "+this.goal.title.replace(/[\r\n]/g," "),"",...claims.map(c=>`${c.uncertain?"Uncertain: ":""}${c.text} ${c.citations.map(x=>`[${x.sourceId}](${s.observations.find(o=>o.id===x.sourceId)!.url??"#"+x.sourceId})`).join(" ")}`),"",...(conflicts.length?["## Conflicting evidence",...conflicts.map(x=>"- "+x),""]:[]),"## Limits and gaps",...limitations.map(x=>"- "+x),...(s.failures.length?[`- ${s.failures.length} recorded tool failures; failed reads are not evidence.`]:[]),"", "## Sources",...sources.map(o=>`- ${o.id}: ${o.title.replace(/[\r\n]/g," ")}${o.url?" — "+o.url:" (Knowledge source)"}. Read ${new Date(o.at).toISOString()}${o.partial?"; partial coverage":""}.`)].join("\n\n");
    const sha256=hash(markdown),path=join(this.goal.workspace!,"report-"+sha256.slice(0,16)+".md");await mkdir(this.goal.workspace!,{recursive:true});await writeFile(path,markdown,{encoding:"utf8"});
    const evidence:GoalEvidence={id:"research:"+sha256,roundId,kind:"file",label:"Research report · citation references checked",detail:"Exact quoted passages and source IDs checked against retained reads. This does not prove semantic entailment or truth.",path,sha256,at:Date.now()};
    s.report={markdown,at:Date.now(),evidence,claims,limitations,conflicts};return s.report;
  });}
}
function stringList(value:unknown,label:string):string[]{if(!Array.isArray(value)||!value.length||value.length>15||value.some(v=>typeof v!=="string"||!v.trim()||v.length>2000))throw Error("Provide bounded "+label+"; explicitly state if none were found.");return value;}
export function validateResearchClaims(args:any,state:ResearchLedger):ResearchClaim[]{
  if(!Array.isArray(args.claims)||!args.claims.length||args.claims.length>40)throw Error("Supply 1–40 specific claims with cited passages.");
  return args.claims.map((c:any)=>{if(typeof c.text!=="string"||!c.text.trim()||c.text.length>3000||!Array.isArray(c.citations)||c.citations.length>6||(!c.citations.length&&!c.uncertain))throw Error("Each factual claim needs citations, or an explicit uncertain label.");
    for(const cite of c.citations){const o=state.observations.find(x=>x.id===cite.sourceId);if(!o||o.kind==="discovery"||typeof cite.quote!=="string"||cite.quote.trim().length<12||cite.quote.length>300||!o.text.includes(cite.quote))throw Error("A citation must quote an exact retained passage from a read source, not a search snippet.");}
    return {text:c.text,citations:c.citations.map((x:any)=>({sourceId:x.sourceId,quote:x.quote})),...(c.uncertain?{uncertain:true}:{})};
  });
}
