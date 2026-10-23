import {readFile} from "node:fs/promises";
import {join,isAbsolute} from "node:path";
import {randomUUID} from "node:crypto";
import {atomicJson,digest} from "./knowledge-store.ts";
import {validateAutomation,nextOccurrence,conditionMatches,conditionValue,watchContent} from "./automations-store.ts";
import {defaultAutomation} from "../automation-contract.ts";
import {type GoalInput,type HubGoal,type GoalRound,type GoalCheckpoint,type GoalEvidence,type GoalApproval,type GoalTrigger} from "../goal-contract.ts";
import {isQuotaFailure} from "./operation-failure.ts";
import type {ProviderGate} from "./provider-gate.ts";
import {validateResearch,RESEARCH_LIMITS} from "../research-contract.ts";

interface State {revision:number;goals:HubGoal[]}
export interface GoalRoundResult {checkpoint?:GoalCheckpoint;evidence:GoalEvidence[];summary:string;nativeGoal?:GoalRound["nativeGoal"];verified?:boolean;yielded?:boolean}
export interface GoalPorts {
  now():number;route(characterId:string):Promise<string>;read(url:string,signal:AbortSignal):Promise<string>;
  admit():(()=>void)|undefined;run(goal:HubGoal,round:GoalRound,signal:AbortSignal):Promise<GoalRoundResult>;
  notify?(goal:HubGoal,kind:"started"|"running"|"completed"|"failed",message:string):void;
  reconcile?(goal:HubGoal):Promise<void>;
}
/** The registry saves policy, dispatch receipts and evidence. Each cycle's
 * native goal log owns its objective and admitted round history. No fabricated
 * human turn is used to authorize the background worker. */
export class GoalsStore {
  private state:State={revision:0,goals:[]};private committed:State=structuredClone(this.state);
  private writes:Promise<unknown>=Promise.resolve();private working?:Promise<void>;private active?:{id:string;abort:AbortController};readonly lifetime=new AbortController();
  constructor(readonly root:string,readonly ports:GoalPorts,readonly gate?:ProviderGate){}
  private exclusive<T>(fn:()=>Promise<T>){const p=this.writes.then(fn,fn);this.writes=p.catch(()=>{});return p;}
  private async save(){this.state.revision++;const next=structuredClone(this.state);await atomicJson(join(this.root,"goals.json"),next);this.committed=next;}
  private record(g:HubGoal,kind:string,message:string){g.updatedAt=this.ports.now();g.history.push({at:g.updatedAt,kind,message:message.slice(0,2500),revision:g.revision});if(g.history.length>2000)g.history.shift();}
  async initialize(){
    try{this.state=JSON.parse(await readFile(join(this.root,"goals.json"),"utf8"));}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    let changed=false;for(const g of this.state.goals){validateGoal(g);for(const r of g.rounds)if(r.status==="running"){
      r.status="interrupted";r.finishedAt=this.ports.now();r.error="Host stopped during this round; partial work remains in its session.";
      const uncertain=g.approvals.some(a=>a.status==="consumed"&&!a.result)||g.resources.writeFolders.length>0;
      if(g.state==="active"&&g.recovery==="read-only"&&!uncertain){g.status="scheduled";g.nextAt=this.ports.now();g.reason="Recovering the saved checkpoint after restart.";}
      else if(g.state==="active"){g.state="paused";g.status="needs-input";g.reason="Inspect the interrupted work and any writes before resuming.";}
      this.record(g,"recovery",g.reason??r.error);changed=true;
    }}if(changed)await this.save();else this.committed=structuredClone(this.state);
  }
  snapshot(){return structuredClone({revision:this.committed.revision,goals:this.committed.goals,hostRunsOnlyWhileOnline:true as const,maxBackgroundWorkers:1 as const});}
  get(id:string){return this.snapshot().goals.find(g=>g.id===id);}
  private cycle(g:HubGoal){let c=g.cycles.at(-1);if(!c||c.status!=="active"){
    const id=randomUUID();c={id,sessionId:`hub-goal-${g.id}-${id}`,startedAt:this.ports.now(),status:"active",evidence:[]};g.cycles.push(c);
    g.plan=[];g.planRevision++;g.checkpoint=undefined;g.criteriaEvidence=[];g.consecutiveFailures=0;g.noProgressRounds=0;
  }return c;}
  async change(command:any){return this.exclusive(async()=>{
    const existing=this.state.goals.find(g=>g.id===command.id);
    // Polling another goal must not invalidate this editor; goal revisions are
    // CAS per record. The global revision protects creation only.
    if(existing?command.revision!==existing.revision:command.revision!==this.state.revision)throw Error("This goal changed; reload it before saving. Your unsaved edits are retained.");
    const now=this.ports.now();let g=existing;
    if(command.action==="save"){
      const input=validateGoal(command.goal);
      if(command.plan!==undefined)validatePlan(command.plan);
      if(!g&&this.state.goals.length>=200)throw Error("Goal limit reached; archive and reuse a saved goal.");
      if(g){
        if(["stopped","archived"].includes(g.state))throw Error("Stopped goals keep their history; create a new draft to repeat this work.");
        const substantive=g.objective!==input.objective||JSON.stringify(g.criteria)!==JSON.stringify(input.criteria);
        Object.assign(g,input);g.revision++;g.updatedAt=now;
        if(substantive){g.criteriaEvidence=[];if(g.state==="completed"){g.state="paused";g.status="paused";}this.record(g,"edited","Outcome or acceptance criteria changed; previous results retained for review.");}
        else this.record(g,"edited","Settings updated. Work uses the new permissions immediately and the new owner at its next checkpoint.");
        if(this.active?.id===g.id)this.active.abort.abort(new Error("Goal settings changed; continue at the next checkpoint."));
        if(g.state==="active"){g.status="scheduled";g.nextAt=now;}
      }else{
        const id=randomUUID();g={...input,id,revision:1,createdAt:now,updatedAt:now,state:"draft",status:"draft",plan:[],planRevision:0,criteriaEvidence:[],rounds:[],cycles:[],evidence:[],approvals:[],activeMs:0,consecutiveFailures:0,noProgressRounds:0,history:[],workspace:join(this.root,id,"workspace")};this.state.goals.push(g);this.record(g,"created","Draft saved. No worker runs until Start.");
      }
      if(command.plan!==undefined){(g!.planHistory??=[]).push({at:now,revision:g!.planRevision,plan:structuredClone(g!.plan)});g!.plan=structuredClone(command.plan);g!.planRevision++;this.record(g!,"plan-edited","Milestone plan updated; previous versions remain in the plan history.");}
    }else{
      if(!g)throw Error("Goal not found");
      if(command.action==="start"||command.action==="resume"||command.action==="wake"||command.action==="resume-credit"){
        if(["stopped","archived"].includes(g.state))throw Error("This goal was stopped; create a new draft instead.");
        await this.ports.route(g.characterId);for(const id of [...g.helpers,...(g.fallbacks??[]),...(g.verifierId?[g.verifierId]:[])])await this.ports.route(id);
        if(g.state==="completed"&&g.schedule.repeat!=="fresh")throw Error("This outcome is completed; create a new draft for a different outcome.");
        if(command.action==="resume-credit"){await this.gate?.clear(g.blockedProvider??(await this.ports.route(g.characterId)).split("/")[0]!);g.blockedProvider=undefined;}
        g.state="active";g.status="scheduled";g.reason=undefined;
        g.nextAt=command.action==="start"?goalNext(g.schedule.trigger,now,true):now;g.scheduledWake=g.nextAt;
        this.record(g,"started",command.action==="start"?"Goal started with its saved schedule and work allowance.":"User authorized continuation from the saved checkpoint.");
      }else if(command.action==="pause"||command.action==="stop"||command.action==="archive"){
        if(this.active?.id===g.id)this.active.abort.abort(new Error("User "+command.action));
        g.state=command.action==="pause"?"paused":command.action==="stop"?"stopped":"archived";g.status=g.state;
        if(command.action!=="pause"){const c=g.cycles.at(-1);if(c?.status==="active"){c.status="stopped";c.finishedAt=now;}}
        this.record(g,command.action,"Work stopped; recorded sessions, evidence and results are preserved.");
      }else if(command.action==="approve"||command.action==="deny"){
        const a=g.approvals.find(a=>a.id===command.approvalId);if(!a||a.status!=="pending"||a.revision!==g.revision)throw Error("This operation changed or is no longer awaiting approval.");
        a.status=command.action==="approve"?"approved":"denied";a.revision=g.revision+1;g.status="scheduled";g.state="active";g.nextAt=now;g.reason=undefined;
        this.record(g,"approval",`${command.action==="approve"?"Approved once":"Denied"}: ${a.description}`);
      }else if(command.action==="accept-result"){
        if(g.status!=="needs-approval"||!g.checkpoint?.complete||!this.hasEvidence(g))throw Error("A current, evidenced result is required before accepting completion.");
        this.finish(g);this.record(g,"approved-result","User accepted the evidenced final result.");
      }else throw Error("Unknown goal action");
      g.revision++;g.updatedAt=now;
    }
    await this.save();await this.ports.reconcile?.(structuredClone(g!));return {snapshot:this.snapshot(),id:g!.id};
  });}
  async requestApproval(id:string,revision:number,request:Pick<GoalApproval,"description"|"tool"|"arguments">){return this.exclusive(async()=>{
    const g=this.state.goals.find(g=>g.id===id);if(!g||g.state!=="active"||g.revision!==revision)throw Error("Goal permission changed before this operation.");
    const key=digest(JSON.stringify(request.arguments)),old=g.approvals.find(a=>a.tool===request.tool&&digest(JSON.stringify(a.arguments))===key&&a.revision===revision&&a.status!=="consumed");
    if(old)return structuredClone(old);
    const a:GoalApproval={...structuredClone(request),id:randomUUID(),revision,at:this.ports.now(),status:"pending"};g.approvals.push(a);g.status="needs-approval";g.reason=request.description;this.record(g,"approval-request",request.description);await this.save();return structuredClone(a);
  });}
  async consumeApproval(id:string,approvalId:string,revision:number){return this.exclusive(async()=>{
    const g=this.state.goals.find(g=>g.id===id),a=g?.approvals.find(a=>a.id===approvalId);
    if(!g||g.state!=="active"||g.revision!==revision||a?.status!=="approved")throw Error("This exact operation needs current user approval.");
    a.status="consumed";await this.save();return structuredClone(a);
  });}
  async actionResult(id:string,approvalId:string,result:string){return this.exclusive(async()=>{const g=this.state.goals.find(g=>g.id===id),a=g?.approvals.find(a=>a.id===approvalId);if(a){a.result=result.slice(0,2000);await this.save();}});}
  async event(type:string,data:unknown){return this.exclusive(async()=>{let changed=false;
    for(const g of this.state.goals)if(g.state==="active"&&g.schedule.trigger.kind==="event"&&g.schedule.trigger.event===type&&conditionMatches(g.schedule.trigger,data)){
      // Coalesce triggers rather than starting overlapping copies of a goal.
      if(g.cycles.at(-1)?.status==="active")continue;
      g.pendingEvent=JSON.stringify({event:type,data}).slice(0,8000);g.nextAt=this.ports.now();g.status="scheduled";changed=true;
    }if(changed)await this.save();
  });}
  tick(){if(this.working||this.lifetime.signal.aborted)return this.working;this.working=this.runDue().finally(()=>this.working=undefined);return this.working;}
  private async runDue(){
    const release=this.ports.admit();if(!release)return;
    let selected:HubGoal|undefined,round:GoalRound|undefined;const abort=new AbortController();
    try{
      await this.exclusive(async()=>{
        const now=this.ports.now();let changed=false;
        const candidates=this.state.goals.filter(g=>g.state==="active"&&g.nextAt!==undefined&&g.nextAt<=now&&!['needs-input','needs-approval','waiting-credit'].includes(g.status)).sort((a,b)=>(a.rounds.at(-1)?.at??a.nextAt!)-(b.rounds.at(-1)?.at??b.nextAt!));
        for(const g of candidates){
          if(g.limits.deadline&&now>=g.limits.deadline){g.status="needs-input";g.reason="Deadline reached. Partial results and unmet criteria are preserved.";changed=true;continue;}
          if(g.activeMs>=g.limits.activeMinutes*60000||g.rounds.length>=g.limits.maxRounds){g.status="waiting-budget";g.state="paused";g.reason="Work allowance reached. Increase the allowance and resume to continue.";changed=true;continue;}
          if(!inWorkingHours(g,now)){g.status="waiting-hours";changed=changed||g.reason!=="Outside your saved working hours.";g.reason="Outside your saved working hours.";continue;}
          const today=day(now),daily=g.rounds.filter(r=>day(r.at)===today);if(daily.length>=g.limits.dailyRounds){g.status="waiting-budget";g.nextAt=nextDay(now);g.reason="Daily round allowance reached; waiting until tomorrow (UTC budget day).";changed=true;continue;}
          let route:string;try{route=await this.ports.route(g.characterId);}catch(e){g.status="needs-input";g.reason=String((e as Error).message);changed=true;continue;}
          let blocked=await this.gate?.reason(route.split("/")[0]!);if(blocked){for(const id of g.fallbacks??[]){const alternative=await this.ports.route(id);if(!await this.gate?.reason(alternative.split("/")[0]!)){route=alternative;blocked=undefined;break;}}}if(blocked){g.status="waiting-credit";g.blockedProvider=route.split("/")[0]!;g.reason=blocked;changed=true;continue;}
          if(!g.cycles.at(-1)||g.cycles.at(-1)?.status!=="active"){
            if(g.schedule.missed==="skip"&&g.schedule.trigger.kind!=="manual"&&now-g.nextAt!>60000&&!g.pendingEvent){g.nextAt=goalNext(g.schedule.trigger,now);g.reason="Missed start skipped by your policy.";if(g.schedule.trigger.kind==="once"){g.state="paused";g.status="needs-input";}changed=true;continue;}
          }
          selected=structuredClone(g);break;
        }
        if(changed)await this.save();
      });
      if(!selected)return;const job=selected;this.active={id:job.id,abort};
      const remaining=Math.max(1,Math.min(180000,job.limits.activeMinutes*60000-job.activeMs,(job.limits.deadline??Infinity)-this.ports.now()));
      const signal=AbortSignal.any([this.lifetime.signal,abort.signal,AbortSignal.timeout(remaining)]);
      if(job.schedule.trigger.kind==="watch"&&!job.pendingEvent&&job.cycles.at(-1)?.status!=="active"){
        const t=job.schedule.trigger,value=watchContent(await this.ports.read(t.url,signal),t.jsonPath),hash=digest(value),match=t.rule==="changed"||conditionValue(t.rule,value,t.value??"");
        const fire=job.lastValue===undefined?!!t.fireOnFirst&&match:t.rule==="changed"?job.lastValue!==hash:match&&!job.lastMatch;
        await this.exclusive(async()=>{const g=this.state.goals.find(g=>g.id===job.id)!;if(g.revision!==job.revision||g.state!=="active")return;g.lastValue=hash;g.lastMatch=match;g.lastCheckAt=this.ports.now();if(fire){job.pendingEvent=g.pendingEvent=`Observed public source (untrusted): ${t.url}\n${value.slice(0,16000)}`;}else{g.nextAt=goalNext(t,this.ports.now());g.status="scheduled";}await this.save();});if(!fire)return;
      }
      await this.exclusive(async()=>{
        const g=this.state.goals.find(g=>g.id===job.id)!;if(g.revision!==job.revision||g.state!=="active"||signal.aborted)return;
        let route=await this.ports.route(g.characterId);if(await this.gate?.reason(route.split("/")[0]!)){for(const id of g.fallbacks??[]){const alternative=await this.ports.route(id);if(!await this.gate?.reason(alternative.split("/")[0]!)){route=alternative;break;}}}if(await this.gate?.reason(route.split("/")[0]!))return;const cost=subscription(route)?0:estimateRound(g);
        const spent=g.rounds.reduce((n,r)=>n+r.estimatedCost,0),daily=g.rounds.filter(r=>day(r.at)===day(this.ports.now())).reduce((n,r)=>n+r.estimatedCost,0);
        if(spent+cost>g.limits.totalBudget||daily+cost>g.limits.dailyBudget){g.status="waiting-budget";g.reason=spent+cost>g.limits.totalBudget?"Total estimated API allowance reached. Increase it and resume.":"Daily estimated API allowance reached; waiting until tomorrow (UTC budget day).";if(spent+cost>g.limits.totalBudget)g.state="paused";else g.nextAt=nextDay(this.ports.now());await this.save();return;}
        const cycle=this.cycle(g);round={id:randomUUID(),cycleId:cycle.id,sessionId:cycle.sessionId,at:this.ports.now(),route,characterId:g.characterId,status:"running",estimatedCost:cost};g.rounds.push(round);g.status=g.plan.length?"working":"planning";g.reason=undefined;g.pendingEvent=undefined;selected=structuredClone({...g,pendingEvent:job.pendingEvent});await this.save();
        if(g.rounds.filter(r=>r.cycleId===cycle.id).length===1)this.ports.notify?.(structuredClone(g),"started","Working toward: "+g.objective.slice(0,1500));
      });
      if(!round)return;
      let result:GoalRoundResult|undefined,error:any;try{result=await this.ports.run(selected!,round,signal);}catch(e){error=e;}
      await this.exclusive(async()=>{
        const g=this.state.goals.find(g=>g.id===job.id)!,r=g.rounds.find(r=>r.id===round!.id)!;r.finishedAt=this.ports.now();g.activeMs+=Math.max(0,r.finishedAt-r.at);
        // Changed settings cannot be satisfied by results against old criteria.
        const sameRevision=g.revision===selected!.revision;
        // Observed effects remain true after pause or a policy edit. Retaining
        // receipts grants no new authority and never accepts an old checkpoint.
        const fresh:GoalEvidence[]=(result?.evidence??error?.goalEvidence??[]).filter((e:GoalEvidence)=>e.roundId===r.id&&!g.evidence.some(old=>old.id===e.id));
        g.evidence.push(...fresh);g.cycles.find(c=>c.id===r.cycleId)?.evidence.push(...fresh.map(e=>e.id));
        if(error){r.status=signal.aborted?"interrupted":"failed";r.error=String(error.message??"Work round failed").slice(0,1500);this.record(g,"round-failed",r.error);
          if(g.state==="active"&&sameRevision){
            if(error.code==="GOAL_SESSION_BUSY"){g.status="waiting-foreground";g.nextAt=this.ports.now()+5000;g.reason=r.error;}
            else if(isQuotaFailure(error)){g.blockedProvider=error.provider??r.route.split("/")[0]!;await this.gate?.block(g.blockedProvider!,r.error);g.status=(g.fallbacks?.length&&g.blockedProvider===r.route.split("/")[0])?"scheduled":"waiting-credit";g.nextAt=this.ports.now()+5000;g.reason=r.error;}
            else if(signal.aborted){g.state="paused";g.status="needs-input";g.reason="Work was interrupted. Inspect its session before resuming.";}
            else if(++g.consecutiveFailures>=3){g.status="needs-input";g.reason="Three consecutive work failures. Inspect the recorded error before resuming.";}
            else{g.status="scheduled";g.reason=r.error;g.nextAt=this.ports.now()+30000;}
          }
        }else if(result){r.status="done";r.summary=result.summary.slice(0,4000);r.nativeGoal=result.nativeGoal;g.consecutiveFailures=0;
          this.record(g,"checkpoint",result.checkpoint?.summary??r.summary??"Round ended.");
          if(sameRevision&&g.state==="active"){
            const cp=result.checkpoint;g.checkpoint=cp??g.checkpoint;
            if(cp?.plan){validatePlan(cp.plan);(g.planHistory??=[]).push({at:this.ports.now(),revision:g.planRevision,plan:structuredClone(g.plan)});g.plan=cp.plan.map(p=>({...p,status:p.status==="done"&&(!p.evidence.length||p.evidence.some(id=>!g.cycles.at(-1)!.evidence.includes(id)))?"pending":p.status}));g.planRevision++;const reached=g.plan.filter(p=>p.status==="done"&&!job.plan.some(old=>old.id===p.id&&old.status==="done"));if(reached.length)this.ports.notify?.(structuredClone(g),"running",reached.map(p=>"Milestone checked: "+p.title).join("\n"));}
            if(cp?.criteria)g.criteriaEvidence=cp.criteria.filter(c=>Number.isInteger(c.index)&&c.index>=0&&c.index<g.criteria.length&&c.evidence.length>0&&c.evidence.every(id=>g.cycles.at(-1)!.evidence.includes(id)));
            if(result.yielded){g.status="waiting-foreground";g.nextAt=this.ports.now()+5000;g.reason="Your live conversation has priority. Continuing after it is idle.";}
            else if(cp?.needsInput){g.status="needs-input";g.reason=cp.needsInput;}
            else if(g.approvals.some(a=>a.status==="pending"&&a.revision===g.revision)){g.status="needs-approval";g.reason="A concrete operation needs your approval in Activity & results.";}
            else if(cp?.complete&&this.hasEvidence(g)){
              if(g.humanApproval){g.status="needs-approval";g.reason="The evidenced result is ready for your final approval.";}
              else if(g.verifierId&&!result.verified){g.status="needs-input";g.reason="The selected verifier did not accept the result; inspect its report.";}
              else this.finish(g);
            }else{
              g.noProgressRounds=fresh.length||cp?.nextAction!==job.checkpoint?.nextAction?0:g.noProgressRounds+1;
              if(g.noProgressRounds>=3){g.status="needs-input";g.reason="Three rounds without new evidence or a changed next step. Adjust the goal or provide input.";}
              else{g.status="scheduled";g.nextAt=this.ports.now()+5000;g.reason=cp?.complete?"Completion needs tool or saved-file evidence for every acceptance criterion.":undefined;}
            }
          }
        }
        await this.save();await this.ports.reconcile?.(structuredClone(g));
        if(g.status==="completed"||g.cycles.at(-1)?.status==="completed")this.ports.notify?.(structuredClone(g),"completed",g.cycles.at(-1)?.result??"Completed.");
        else if(["needs-input","needs-approval","waiting-credit"].includes(g.status))this.ports.notify?.(structuredClone(g),"failed",g.reason??g.status);
      });
    }catch(e){if(selected)await this.exclusive(async()=>{const g=this.state.goals.find(g=>g.id===selected!.id)!;if(g.state==="active"){g.status="needs-input";g.reason=String((e as Error).message).slice(0,1500);this.record(g,"error",g.reason);await this.save();}});}
    finally{this.active=undefined;release();}
  }
  private hasEvidence(g:HubGoal){return g.criteria.every((_c,index)=>g.criteriaEvidence.some(c=>c.index===index&&c.evidence.length&&c.evidence.every(id=>g.cycles.at(-1)?.evidence.includes(id))));}
  private finish(g:HubGoal){const cycle=g.cycles.at(-1)!;cycle.status="completed";cycle.finishedAt=this.ports.now();cycle.result=g.checkpoint?.result??g.checkpoint?.summary;g.reason=undefined;
    const repeat=g.schedule.repeat==="fresh"&&!['manual','once'].includes(g.schedule.trigger.kind);g.state=repeat?"active":"completed";g.status=repeat?"scheduled":"completed";g.nextAt=repeat?goalNext(g.schedule.trigger,this.ports.now()):undefined;this.record(g,"completed",repeat?"Cycle completed with evidence. Waiting for the next scheduled result.":"Outcome completed with acceptance evidence.");}
  async dispose(){this.lifetime.abort();await this.working;await this.writes;}
}
export function subscription(route:string){return /^(openai-codex|ollama|lm-studio|lmstudio|local)\//.test(route);}
function estimateRound(g:HubGoal){return g.limits.maxSteps*((Buffer.byteLength(g.objective+JSON.stringify(g.checkpoint??{}))+64000)*g.limits.inputPrice+g.limits.maxOutputTokens*g.limits.outputPrice)/1e6;}
function day(at:number){return new Date(at).toISOString().slice(0,10);}
function nextDay(at:number){return Date.parse(day(at)+"T00:00:00Z")+86400000;}
export function goalNext(t:GoalTrigger,after:number,start=false):number|undefined {return t.kind==="manual"?start?after:undefined:nextOccurrence(t,after);}
export function inWorkingHours(g:GoalInput,at:number){const h=g.limits.workingHours;if(!h)return true;const p=Object.fromEntries(new Intl.DateTimeFormat("en-US",{timeZone:h.timezone,weekday:"short",hour:"2-digit",minute:"2-digit",hourCycle:"h23"}).formatToParts(at).map(p=>[p.type,p.value]));const minutes=Number(p.hour)*60+Number(p.minute);return h.days.includes(["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].indexOf(p.weekday!))&&(h.start<h.end?minutes>=h.start&&minutes<h.end:minutes>=h.start||minutes<h.end);}
export function validatePlan(plan:any):asserts plan is HubGoal["plan"] {
  if(!Array.isArray(plan)||plan.length>80||plan.some(p=>!p||typeof p.id!=="string"||!p.id||p.id.length>80||typeof p.title!=="string"||!p.title.trim()||p.title.length>1000||!["pending","working","done"].includes(p.status)||!Array.isArray(p.dependsOn)||!Array.isArray(p.evidence)))throw Error("Invalid milestone plan");
  const ids=new Set(plan.map(p=>p.id));if(ids.size!==plan.length||plan.some(p=>p.dependsOn.some((id:string)=>id===p.id||!ids.has(id))))throw Error("Milestones need unique IDs and valid dependencies");
  const visit=(id:string,path:Set<string>)=>{if(path.has(id))throw Error("Milestone dependencies contain a cycle");for(const dep of plan.find(p=>p.id===id)!.dependsOn)visit(dep,new Set([...path,id]));};for(const p of plan)visit(p.id,new Set());
}
export function validateGoal(v:any):GoalInput {
  const research=v?.research?validateResearch(v.research):undefined;
  if(!v||typeof v.title!=="string"||!v.title.trim()||v.title.length>160||typeof v.objective!=="string"||!v.objective.trim()||v.objective.length>12000||!Array.isArray(v.criteria)||!v.criteria.length||v.criteria.length>20||v.criteria.some((c:any)=>typeof c!=="string"||!c.trim()||c.length>2000)||typeof v.characterId!=="string"||!v.characterId||v.characterId.length>100)throw Error("Set the outcome, acceptance criteria and owner character.");
  if(!["quick","balanced","thorough","custom"].includes(v.approach)||typeof v.instructions!=="string"||v.instructions.length>12000||!Array.isArray(v.helpers)||v.helpers.length>5||v.helpers.some((id:any)=>typeof id!=="string"||id.length>100)||v.fallbacks&&(!Array.isArray(v.fallbacks)||v.fallbacks.length>5||v.fallbacks.some((id:any)=>typeof id!=="string"||id.length>100))||v.verifierId&&(typeof v.verifierId!=="string"||v.verifierId.length>100))throw Error("Invalid character or approach settings");
  const r=v.resources,l=v.limits,s=v.schedule;if(!r||!l||!s)throw Error("Resources, work allowance and schedule are required");
  for(const key of ["knowledge","browser","knowledgeOutput"])if(typeof r[key]!=="boolean")throw Error("Invalid resource access setting");
  for(const key of ["folders","files","writeFolders","tools"])if(!Array.isArray(r[key])||r[key].length>30||r[key].some((p:any)=>typeof p!=="string"||!p.trim()||p.length>500))throw Error("Invalid resource list: "+key);
  for(const p of [...r.folders,...r.files,...r.writeFolders])if(!isAbsolute(p)||p.includes("\0"))throw Error("Resources must be absolute host paths");
  for(const [key,min,max]of [["maxRounds",1,10000],["activeMinutes",1,10080],["maxSteps",1,20],["maxOutputTokens",256,16384],["dailyRounds",1,1000]] as const)if(!Number.isInteger(l[key])||l[key]<min||l[key]>max)throw Error("Invalid work allowance: "+key);
  for(const key of ["dailyBudget","totalBudget","inputPrice","outputPrice"])if(!Number.isFinite(l[key])||l[key]<=0||l[key]>10000)throw Error("Invalid API estimate: "+key);
  if(l.deadline&&(!Number.isSafeInteger(l.deadline)||l.deadline<=0))throw Error("Invalid deadline");
  if(l.workingHours){const h=l.workingHours;if(!Number.isInteger(h.start)||!Number.isInteger(h.end)||h.start<0||h.start>1439||h.end<0||h.end>1439||h.start===h.end||!Array.isArray(h.days)||!h.days.length||h.days.some((d:any)=>!Number.isInteger(d)||d<0||d>6))throw Error("Invalid working hours");new Intl.DateTimeFormat("en",{timeZone:h.timezone}).format(0);}
  if(!["continue","fresh"].includes(s.repeat)||!['skip','catch-up'].includes(s.missed))throw Error("Invalid recurrence policy");
  if(s.trigger?.kind!=="manual")validateAutomation({...defaultAutomation,title:v.title,prompt:v.objective,characterId:v.characterId,trigger:s.trigger});
  if(!["read-only","ask"].includes(v.recovery)||typeof v.humanApproval!=="boolean"||!['pwa','telegram'].includes(v.notification)||v.notification==="telegram"&&!/^minke-im-telegram-[a-f0-9]{32}$/.test(v.sourceSessionId??""))throw Error("Choose recovery, verification and a paired notification destination.");
  if(research){const cap=RESEARCH_LIMITS[research.depth];if(!r.browser||r.knowledge!== (research.sources==="web+knowledge")||r.knowledgeOutput||r.folders.length||r.files.length||r.writeFolders.length||r.tools.length||v.helpers.length||v.fallbacks?.length||v.verifierId||s.trigger?.kind!=="manual"||s.repeat!=="continue"||l.maxRounds>cap.rounds||l.maxSteps>cap.steps||l.maxOutputTokens>cap.output||l.activeMinutes>cap.minutes)throw Error("Research uses bounded, read-only resources and one configured researcher.");}
  return structuredClone({...(research?{research}:{}),title:v.title.trim(),objective:v.objective,criteria:v.criteria.map((c:string)=>c.trim()),characterId:v.characterId,approach:v.approach,instructions:v.instructions,helpers:[...new Set(v.helpers)] as string[],fallbacks:[...new Set(v.fallbacks??[])] as string[],verifierId:v.verifierId||undefined,resources:r,limits:l,schedule:s,recovery:v.recovery,humanApproval:v.humanApproval,notification:v.notification,sourceSessionId:v.sourceSessionId});
}
