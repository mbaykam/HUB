import {spawn,type ChildProcess} from "node:child_process";
import {createServer,type IncomingMessage,type Server,type ServerResponse} from "node:http";
import {randomBytes,randomUUID} from "node:crypto";
import {existsSync} from "node:fs";
import {mkdtemp,writeFile,rm} from "node:fs/promises";
import {tmpdir,homedir} from "node:os";
import {join,delimiter} from "node:path";
import {createInterface} from "node:readline";

/** Claude Code as a HUB model provider: the user's own Claude subscription,
 * through the installed `claude` CLI, with HUB's tools.
 *
 * Each turn starts the CLI with its built-in tools switched off and HUB's tools
 * offered over a private loopback MCP server. When Claude calls a tool, the
 * adapter hands that call to HUB's normal tool loop (permissions, approvals,
 * activity) and keeps the CLI waiting; the next model call carries the result
 * back to it. So Claude Code behaves like any other model inside HUB. */
export const CLAUDE_CODE_PROVIDER="claude-code";
export const CLAUDE_CODE_MODELS=[
  {id:"opus",name:"Claude Opus · Claude Code",description:"Anthropic's most capable model, on your Claude subscription."},
  {id:"sonnet",name:"Claude Sonnet · Claude Code",description:"Fast and strong for most work, on your Claude subscription."},
  {id:"haiku",name:"Claude Haiku · Claude Code",description:"Quickest and lightest, on your Claude subscription."},
] as const;
const EFFORTS=["low","medium","high","xhigh","max"];

interface Tool {name:string;description:string;parameters:Record<string,unknown>}
interface Options {model:string;reasoningEffort?:string;messages:any[];system?:string;tools?:Tool[];signal?:AbortSignal;sessionId?:string;maxTokens?:number}
type Event=
  |{kind:"text";text:string}|{kind:"thinking";text:string}|{kind:"blockEnd"}
  |{kind:"tool";id:string;name:string;args:string}
  |{kind:"result";ok:boolean;message?:string;usage?:any}
  |{kind:"exit";code:number|null;stderr:string};

/** Where the CLI lives: an explicit override, the official installer's
 * location, then PATH. HUB may have started before the CLI was installed, so
 * PATH alone is not enough. */
export function findClaude(env:NodeJS.ProcessEnv=process.env,exists=(path:string)=>existsSync(path),platform=process.platform){
  const windows=platform==="win32",names=windows?["claude.exe"]:["claude"];
  const candidates=[env.HUB_CLAUDE_CODE_PATH,join(env.USERPROFILE??env.HOME??homedir(),".local","bin",names[0]!),
    ...String(env.PATH??env.Path??"").split(delimiter).filter(Boolean).flatMap(dir=>names.map(name=>join(dir,name)))].filter((v):v is string=>!!v);
  return candidates.find(path=>exists(path));
}

/** The Claude subscription's limits as Claude Code last reported them. Every
 * CLI run emits a rate_limit_event, so these are as fresh as HUB's latest
 * Claude Code turn; the copy on disk survives a HUB restart. */
export interface ClaudeCodeLimits {observedAt:string;windows:{id:string;usedPercent:number;resetsAt?:number;status?:string}[];warning?:string}
let latestLimits:ClaudeCodeLimits|undefined;
const limitsFile=()=>join(process.env.DSH_HOME??join(homedir(),".dsh"),"hub-claude-code","limits.json");

export function parseClaudeCodeLimits(info:any,now=new Date()):ClaudeCodeLimits|undefined{
  if(!info||typeof info!=="object")return;
  const used=(value:unknown)=>typeof value==="number"&&Number.isFinite(value)?Math.round(Math.min(1,Math.max(0,value))*1000)/10:undefined;
  const window=(id:string,value:any)=>{const usedPercent=used(value?.utilization);if(usedPercent===undefined)return;
    return {id,usedPercent,...(typeof value.resetsAt==="number"&&value.resetsAt>0?{resetsAt:value.resetsAt}:{}),...(typeof value.status==="string"?{status:value.status.slice(0,40)}:{})};};
  const unified=info.unifiedWindows&&typeof info.unifiedWindows==="object"?info.unifiedWindows:{};
  let windows=Object.entries(unified).slice(0,6).map(([id,value])=>window(id.slice(0,40),value)).filter((w):w is NonNullable<typeof w>=>!!w);
  if(!windows.length&&typeof info.rateLimitType==="string"){const only=window(info.rateLimitType.slice(0,40),info);if(only)windows=[only];}
  if(!windows.length)return;
  const blocked=windows.find(w=>w.status==="rejected");
  return {observedAt:now.toISOString(),windows,...(blocked?{warning:"Claude Code has reached this limit; HUB can use it again when it resets."}:{})};
}

export function noteClaudeCodeLimits(info:unknown){
  const limits=parseClaudeCodeLimits(info);if(!limits)return;
  latestLimits=limits;
  const file=limitsFile();
  void import("node:fs/promises").then(fs=>fs.mkdir(join(file,".."),{recursive:true}).then(()=>fs.writeFile(file,JSON.stringify(limits),{mode:0o600}))).catch(()=>{});
}

/** For the Usage page: ready limits, "waiting" until Claude Code has run once, or not configured without the CLI. */
export async function readClaudeCodeUsage(installed=!!findClaude()){
  if(!latestLimits){try{const {readFile}=await import("node:fs/promises");const saved=JSON.parse(await readFile(limitsFile(),"utf8"));
    if(saved&&typeof saved.observedAt==="string"&&Array.isArray(saved.windows))latestLimits=saved;}catch{}}
  if(latestLimits)return {state:"ready" as const,...latestLimits};
  return installed?{state:"waiting" as const}:{state:"not-configured" as const};
}

const textOf=(blocks:any[]|undefined)=>(blocks??[]).map(block=>block?.type==="text"?block.text:block?.type==="image"?"[image]":"").filter(Boolean).join("\n");
const clip=(text:string,max:number)=>text.length>max?text.slice(0,max)+`\n[… ${text.length-max} more characters]`:text;

/** The conversation so far as one prompt for a fresh CLI run. */
export function conversationPrompt(messages:any[]){
  const parts:string[]=[];
  for(const message of messages){
    if(message.role==="system")continue;
    for(const block of message.content??[]){
      if(block.type==="text"&&block.text.trim())parts.push(`${message.role==="assistant"?"Assistant":"User"}: ${block.text}`);
      else if(block.type==="image")parts.push(`${message.role==="assistant"?"Assistant":"User"}: [an image was attached]`);
      else if(block.type==="tool-call")parts.push(`Assistant called ${block.name}(${clip(block.arguments??"",2000)})`);
      else if(block.type==="tool-result")parts.push(`${block.isError?"Tool error":"Tool result"}: ${clip(textOf(block.content),4000)}`);
    }
  }
  if(parts.length===1&&parts[0]!.startsWith("User: "))return parts[0]!.slice(6);
  return `<conversation>\n${parts.join("\n\n")}\n</conversation>\n\nContinue as the assistant: respond to the latest user message above.`;
}

/** Tool results at the end of a request, newest call last. */
export function trailingToolResults(messages:any[]){
  const results:any[]=[];
  for(let i=messages.length-1;i>=0;i--){
    const message=messages[i];if(message.role!=="user")break;
    const found=(message.content??[]).filter((b:any)=>b.type==="tool-result");
    if(!found.length){if(message.source?.kind==="user")break;continue;}
    results.unshift(...found);
  }
  return results;
}

class Queue<T>{
  #items:T[]=[];#waiters:((v:T)=>void)[]=[];
  push(item:T){const waiter=this.#waiters.shift();if(waiter)waiter(item);else this.#items.push(item);}
  next(timeoutMs?:number):Promise<T|undefined>{
    if(this.#items.length)return Promise.resolve(this.#items.shift());
    return new Promise(resolve=>{let timer:ReturnType<typeof setTimeout>|undefined;
      const waiter=(v:T)=>{if(timer)clearTimeout(timer);resolve(v);};this.#waiters.push(waiter);
      if(timeoutMs!==undefined)timer=setTimeout(()=>{const i=this.#waiters.indexOf(waiter);if(i>=0)this.#waiters.splice(i,1);resolve(undefined);},timeoutMs);});
  }
}

interface Run {key:string;token:string;secret:string;proc?:ChildProcess;events:Queue<Event>;tools:Tool[];pending:Map<string,(result:any)=>void>;dir?:string;done:boolean;touched:number;call?:CallUsage;limits?:ClaudeCodeLimits}
interface CallUsage {input:number;cacheRead:number;cacheWrite:number;output:number}

/** HUB measures the conversation from each model call's usage. The CLI's
 * final result adds up every call of the run (a six-step turn on a 100k
 * conversation reports ~700k), which made HUB compact the chat before nearly
 * every Claude Code turn. So each step reports its own call. */
export function callUsage(call:CallUsage){
  return {inputTokens:call.input+call.cacheRead+call.cacheWrite,outputTokens:call.output,
    ...(call.cacheRead?{cacheReadTokens:call.cacheRead}:{}),...(call.cacheWrite?{cacheWriteTokens:call.cacheWrite}:{})};
}

export interface SpawnClaude {(command:string,args:string[],options:{cwd:string;env:NodeJS.ProcessEnv}):ChildProcess}

/** When the Claude subscription's window is used up, until when (ms), from
 * the CLI's latest rate-limit report. */
export function claudeCodeBlockedUntil(now=Date.now(),limits=latestLimits){
  const until=(limits?.windows??[]).filter(w=>w.status==="rejected"&&typeof w.resetsAt==="number"&&w.resetsAt*1000>now).map(w=>w.resetsAt!*1000);
  return until.length?Math.max(...until):undefined;
}
const LIMIT_MESSAGE=/hit your .*limit|usage limit|limit reached/i;

export function subscriptionLimitFailure(model:string,resetsAt?:number,message="Claude Code has reached its subscription limit."){
  return {code:"subscription-limit",message,subscriptionLimit:{provider:CLAUDE_CODE_PROVIDER,model,kind:"subscription-quota",...(resetsAt?{resetsAt}:{}),resetSource:resetsAt?"cli":"unknown"}};
}

/** Legacy registration shape retained for compatibility. Automatic fallback
 * is disabled; no route or stream callback is invoked. */
export interface ClaudeCodeFallback {
  route():{provider:string;model:string;reasoningEffort?:string}|undefined;
  stream(options:any):AsyncIterable<any>;
}

export class ClaudeCodeAdapter {
  #runs=new Map<string,Run>();#byToken=new Map<string,Run>();#server?:Promise<{server:Server;port:number}>;#sweeper?:ReturnType<typeof setInterval>;
  constructor(readonly command:string,readonly launch:SpawnClaude=(command,args,options)=>spawn(command,args,{...options,stdio:["pipe","pipe","pipe"],windowsHide:true}),readonly fallback?:ClaudeCodeFallback){}

  // Legacy fallback argument is accepted for source compatibility, never invoked.

  providerInfo(provider:string){return {id:provider,name:"Claude Code"};}
  providerRetryPolicy(){return undefined;}
  imageRequestPricing(){return undefined;}
  async listModels(provider:string){return CLAUDE_CODE_MODELS.map(m=>({provider,id:m.id,name:m.name,description:m.description,inputModalities:["text"] as const}));}
  async resolveModel(provider:string,model:string){
    const known=CLAUDE_CODE_MODELS.find(m=>m.id===model);
    return {provider,id:model,name:known?.name??model,...(known?{description:known.description}:{}),inputModalities:["text"] as const,
      context:{contextWindow:200000},defaultMaxTokens:32000,
      reasoning:{efforts:EFFORTS.map(id=>({id,name:id==="xhigh"?"Extra high":id[0]!.toUpperCase()+id.slice(1)})),defaultEffort:"medium"}};
  }
  async prepareCall(provider:string,model:string,_signal?:AbortSignal){return {model:await this.resolveModel(provider,model),stream:(options:Options)=>this.stream(options)};}

  async *stream(options:Options):AsyncGenerator<any>{
    const key=options.sessionId??randomUUID();
    let run=this.#runs.get(key);
    const results=trailingToolResults(options.messages);
    if(run&&!run.done&&run.pending.size&&results.length&&results.every(r=>run!.pending.has(r.toolCallId))){
      // The answer to the tool calls Claude is waiting on.
      for(const result of results){const respond=run.pending.get(result.toolCallId)!;run.pending.delete(result.toolCallId);respond(result);}
    }else{
      if(run)this.#finish(run);
      await readClaudeCodeUsage();
      const until=claudeCodeBlockedUntil();
      const unknown=(latestLimits?.windows??[]).some(w=>w.status==="rejected"&&!w.resetsAt);
      if(until||unknown){yield {type:"finish",reason:{kind:"error",failure:subscriptionLimitFailure(options.model,unknown?undefined:until)}};return;}
      run=await this.#start(key,options);
    }
    run.tools=options.tools??[];run.touched=Date.now();
    const current=run,abort=()=>this.#finish(current);
    options.signal?.addEventListener("abort",abort,{once:true});
    try{yield* this.#pump(current,options);}
    finally{options.signal?.removeEventListener("abort",abort);}
  }

  async *#pump(run:Run,options:Options):AsyncGenerator<any>{
    let index=0,open:{index:number;type:"text"|"reasoning";text:string}|undefined;
    const close=function*(){if(open){yield {type:"block-end",index:open.index,block:{type:open.type,text:open.text}};open=undefined;}};
    const write=function*(type:"text"|"reasoning",text:string){
      if(open?.type!==type){yield* close();open={index:index++,type,text:""};yield {type:"block-start",index:open.index,blockType:type};}
      open.text+=text;yield {type:type==="text"?"text-delta":"reasoning-delta",index:open.index,text};
    };
    let calls=0;
    while(true){
      if(options.signal?.aborted){yield* close();yield {type:"finish",reason:{kind:"aborted",failure:{message:"Stopped.",code:"aborted"}}};return;}
      const event=await run.events.next(calls?150:undefined);
      if(!event){
        // A batch of tool calls is complete: hand them to HUB and wait.
        yield {type:"usage",usage:run.call?callUsage(run.call):{inputTokens:0,outputTokens:0}};
        yield {type:"finish",reason:{kind:"tool-calls"}};return;
      }
      if(event.kind==="text"||event.kind==="thinking"){yield* write(event.kind==="text"?"text":"reasoning",event.text);continue;}
      // The model finished this block: show it whole now, not when the next block starts.
      if(event.kind==="blockEnd"){yield* close();continue;}
      if(event.kind==="tool"){
        yield* close();const at=index++;calls++;
        yield {type:"block-start",index:at,blockType:"tool-call"};
        yield {type:"tool-call-delta",index:at,id:event.id,name:event.name,argumentsDelta:event.args};
        yield {type:"block-end",index:at,block:{type:"tool-call",id:event.id,name:event.name,arguments:event.args}};
        continue;
      }
      yield* close();
      if(event.kind==="result"){
        const u=event.usage??{};
        if(run.call)yield {type:"usage",usage:callUsage(run.call)};
        else yield {type:"usage",usage:{inputTokens:Number(u.input_tokens??0)+Number(u.cache_read_input_tokens??0)+Number(u.cache_creation_input_tokens??0),outputTokens:Number(u.output_tokens??0),
          ...(u.cache_read_input_tokens?{cacheReadTokens:Number(u.cache_read_input_tokens)}:{}),...(u.cache_creation_input_tokens?{cacheWriteTokens:Number(u.cache_creation_input_tokens)}:{})}};
        this.#finish(run);
        if(!event.ok&&LIMIT_MESSAGE.test(event.message??"")){
          yield {type:"finish",reason:{kind:"error",failure:subscriptionLimitFailure(options.model,run.limits?claudeCodeBlockedUntil(Date.now(),run.limits):undefined,event.message)}};return;
        }
        yield event.ok?{type:"finish",reason:{kind:"stop"}}:{type:"finish",reason:{kind:"error",failure:{message:event.message??"Claude Code could not finish.",code:"claude-code-error"}}};
        return;
      }
      this.#finish(run);
      const signedOut=/log ?in|login|auth|credential|subscription/i.test(event.stderr);
      yield {type:"finish",reason:{kind:"error",failure:{message:signedOut?"Claude Code is not signed in on the HUB PC. Run `claude` there once and sign in.":
        "Claude Code stopped unexpectedly"+(event.stderr?": "+event.stderr.slice(-300):"."),code:signedOut?"claude-code-auth":"claude-code-exit"}}};
      return;
    }
  }

  async #start(key:string,options:Options):Promise<Run>{
    const {port}=await this.#mcp();
    const run:Run={key,token:randomUUID(),secret:randomBytes(24).toString("hex"),events:new Queue<Event>(),tools:options.tools??[],pending:new Map(),done:false,touched:Date.now()};
    this.#runs.set(key,run);this.#byToken.set(run.token,run);
    run.dir=await mkdtemp(join(tmpdir(),"hub-claude-code-"));
    const systemFile=join(run.dir,"system.md");await writeFile(systemFile,options.system??"You are HUB, a helpful assistant.",{mode:0o600});
    const mcp=JSON.stringify({mcpServers:{hub:{type:"http",url:`http://127.0.0.1:${port}/mcp/${run.token}`,headers:{authorization:"Bearer "+run.secret}}}});
    const effort=options.reasoningEffort&&EFFORTS.includes(options.reasoningEffort)?["--effort",options.reasoningEffort]:[];
    const args=["-p","--input-format","stream-json","--output-format","stream-json","--verbose","--include-partial-messages",
      "--model",options.model,...effort,"--tools","","--strict-mcp-config","--mcp-config",mcp,"--allowedTools","mcp__hub",
      "--system-prompt-file",systemFile,"--setting-sources","","--max-turns","100"];
    const proc=this.launch(this.command,args,{cwd:run.dir,env:{...process.env,MCP_TOOL_TIMEOUT:"3600000",CLAUDE_CODE_ENTRYPOINT:"sdk-ts"}});
    run.proc=proc;let stderr="",result=false;
    proc.stderr?.on("data",chunk=>{stderr=(stderr+String(chunk)).slice(-4000);});
    proc.on("error",error=>{if(!run.done)run.events.push({kind:"exit",code:null,stderr:String(error.message)});});
    const lines=createInterface({input:proc.stdout!});
    lines.on("line",line=>{let value:any;try{value=JSON.parse(line);}catch{return;}
      if(value.type==="stream_event"){const delta=value.event?.delta,n=(v:unknown)=>Number(v??0)||0;
        if(value.event?.type==="message_start"){const u=value.event.message?.usage??{};
          run.call={input:n(u.input_tokens),cacheRead:n(u.cache_read_input_tokens),cacheWrite:n(u.cache_creation_input_tokens),output:n(u.output_tokens)};}
        else if(value.event?.type==="message_delta"&&run.call&&value.event.usage?.output_tokens!==undefined)run.call.output=n(value.event.usage.output_tokens);
        else if(value.event?.type==="content_block_stop")run.events.push({kind:"blockEnd"});
        else if(value.event?.type==="content_block_delta"&&delta?.type==="text_delta"&&delta.text)run.events.push({kind:"text",text:delta.text});
        else if(value.event?.type==="content_block_delta"&&delta?.type==="thinking_delta"&&delta.thinking)run.events.push({kind:"thinking",text:delta.thinking});}
      else if(value.type==="rate_limit_event"){run.limits=parseClaudeCodeLimits(value.rate_limit_info);noteClaudeCodeLimits(value.rate_limit_info);}
      else if(value.type==="result"){result=true;run.events.push({kind:"result",ok:!value.is_error,message:typeof value.result==="string"&&value.is_error?value.result:undefined,usage:value.usage});}
    });
    proc.on("close",code=>{if(!result&&!run.done)run.events.push({kind:"exit",code,stderr});});
    proc.stdin?.on("error",()=>{});
    proc.stdin?.end(JSON.stringify({type:"user",message:{role:"user",content:[{type:"text",text:conversationPrompt(options.messages)}]}})+"\n");
    if(!this.#sweeper){this.#sweeper=setInterval(()=>{const now=Date.now();for(const r of this.#runs.values())if(now-r.touched>3600000)this.#finish(r);},60000);this.#sweeper.unref?.();}
    return run;
  }

  #finish(run:Run){
    if(run.done)return;run.done=true;
    for(const respond of run.pending.values())respond({isError:true,content:[{type:"text",text:"The conversation moved on before this tool finished."}]});
    run.pending.clear();
    if(this.#runs.get(run.key)===run)this.#runs.delete(run.key);this.#byToken.delete(run.token);
    try{run.proc?.stdin?.destroy();}catch{}
    if(run.proc&&run.proc.exitCode===null)try{run.proc.kill();}catch{}
    if(run.dir)void rm(run.dir,{recursive:true,force:true}).catch(()=>{});
  }

  /** The loopback MCP endpoint the CLI calls for HUB's tools. Only a run's own
   * secret opens it, and only from this PC. */
  #mcp(){
    this.#server??=new Promise((resolve,reject)=>{
      const server=createServer((req,res)=>void this.#handle(req,res).catch(()=>{if(!res.headersSent){res.writeHead(500);res.end();}}));
      server.requestTimeout=0;server.headersTimeout=60000;
      server.once("error",reject);
      server.listen(0,"127.0.0.1",()=>{const address=server.address();server.unref();resolve({server,port:typeof address==="object"&&address?address.port:0});});
    });
    return this.#server;
  }

  async #handle(req:IncomingMessage,res:ServerResponse){
    const match=/^\/mcp\/([0-9a-f-]{36})$/.exec(new URL(req.url??"/","http://127.0.0.1").pathname);
    const run=match?this.#byToken.get(match[1]!):undefined;
    if(!run||req.headers.authorization!=="Bearer "+run.secret){res.writeHead(404);res.end();return;}
    if(req.method==="GET"){res.writeHead(405,{allow:"POST, DELETE"});res.end();return;}
    if(req.method==="DELETE"){res.writeHead(200);res.end();return;}
    if(req.method!=="POST"){res.writeHead(405);res.end();return;}
    const chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>4_000_000){res.writeHead(413);res.end();return;}chunks.push(chunk);}
    let body:any;try{body=JSON.parse(Buffer.concat(chunks).toString("utf8"));}catch{res.writeHead(400);res.end();return;}
    const batch=Array.isArray(body),answers=(await Promise.all((batch?body:[body]).map((message:any)=>this.#answer(run,message)))).filter(Boolean);
    if(!answers.length){res.writeHead(202);res.end();return;}
    res.writeHead(200,{"content-type":"application/json","mcp-session-id":run.token});
    res.end(JSON.stringify(batch?answers:answers[0]));
  }

  async #answer(run:Run,message:any){
    if(message?.id===undefined||message.id===null)return undefined; // a notification
    const reply=(result:unknown)=>({jsonrpc:"2.0",id:message.id,result});
    switch(message.method){
      case "initialize":return reply({protocolVersion:typeof message.params?.protocolVersion==="string"?message.params.protocolVersion:"2025-06-18",capabilities:{tools:{listChanged:false}},serverInfo:{name:"hub",version:"1.0.0"}});
      case "ping":return reply({});
      // readOnlyHint lets the CLI send every call of one answer at once instead of
      // one per round trip; HUB's own tool loop still decides permissions and order.
      case "tools/list":return reply({tools:run.tools.map(tool=>({name:tool.name,description:tool.description,inputSchema:tool.parameters&&typeof tool.parameters==="object"?tool.parameters:{type:"object"},annotations:{readOnlyHint:true}}))});
      case "tools/call":{
        if(run.done)return reply({isError:true,content:[{type:"text",text:"This turn has ended."}]});
        const id="cc_"+randomUUID().replace(/-/g,""),name=String(message.params?.name??"");
        if(!run.tools.some(tool=>tool.name===name))return reply({isError:true,content:[{type:"text",text:`Unknown tool ${name}.`}]});
        const result=await new Promise<any>(resolve=>{run.pending.set(id,resolve);run.events.push({kind:"tool",id,name,args:JSON.stringify(message.params?.arguments??{})});});
        const content=(result.content??[]).map((block:any)=>block.type==="text"?{type:"text",text:block.text}:{type:"text",text:block.type==="image"?"[HUB returned an image; it is shown to the user in the chat.]":"["+block.type+"]"});
        return reply({isError:!!result.isError,content:content.length?content:[{type:"text",text:"(no output)"}]});
      }
      default:return {jsonrpc:"2.0",id:message.id,error:{code:-32601,message:"Method not found"}};
    }
  }

  dispose(){for(const run of [...this.#runs.values()])this.#finish(run);if(this.#sweeper)clearInterval(this.#sweeper);void this.#server?.then(({server})=>server.close()).catch(()=>{});}
}

/** Registers Claude Code when the CLI is installed on this PC. */
export function installClaudeCodeProvider(ctx:any,_fallbackRoute?:ClaudeCodeFallback["route"]){
  const command=findClaude();
  if(!command||typeof ctx.llm?.registerAdapter!=="function")return ()=>{};
  const adapter=new ClaudeCodeAdapter(command);
  let off:(()=>void)|undefined;
  try{off=ctx.llm.registerAdapter([CLAUDE_CODE_PROVIDER],adapter as any);}catch{adapter.dispose();return ()=>{};}
  return ()=>{off?.();adapter.dispose();};
}
