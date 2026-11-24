import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ClaudeCodeAdapter,findClaude,conversationPrompt,trailingToolResults,CLAUDE_CODE_MODELS,parseClaudeCodeLimits,claudeCodeBlockedUntil} from '../packages/harness-overlay/src/host/claude-code-provider.ts';

// A stand-in for the claude CLI: reads the prompt, optionally calls one tool on
// the MCP server it was given, then reports a result, like the real CLI does.
const FAKE=`
const args=process.argv.slice(2),config=JSON.parse(args[args.indexOf('--mcp-config')+1]).mcpServers.hub;
const out=v=>process.stdout.write(JSON.stringify(v)+'\\n');
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',async()=>{
  const prompt=JSON.parse(input.trim()).message.content[0].text;
  const rpc=async body=>(await fetch(config.url,{method:'POST',headers:{...config.headers,'content-type':'application/json'},body:JSON.stringify(body)})).json();
  await rpc({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});
  const tools=(await rpc({jsonrpc:'2.0',id:2,method:'tools/list'})).result.tools;
  if(prompt.includes('use the tool')){
    out({type:'stream_event',event:{type:'message_start',message:{usage:{input_tokens:10,cache_read_input_tokens:90000,cache_creation_input_tokens:5000,output_tokens:1}}}});
    out({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Checking. '}}});
    out({type:'stream_event',event:{type:'message_delta',usage:{output_tokens:40}}});
    const result=await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:tools[0].name,arguments:{q:1}}});
    out({type:'stream_event',event:{type:'message_start',message:{usage:{input_tokens:20,cache_read_input_tokens:95000,cache_creation_input_tokens:0,output_tokens:1}}}});
    out({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Got: '+result.result.content[0].text}}});
    out({type:'stream_event',event:{type:'message_delta',usage:{output_tokens:30}}});
  }else if(prompt.includes('crash')){process.stderr.write('boom');process.exit(3);}
  else if(prompt.includes('out of quota')){out({type:'rate_limit_event',rate_limit_info:{rateLimitType:'five_hour',utilization:1,resetsAt:Math.floor(Date.now()/1000)+3600,status:'rejected'}});out({type:'result',subtype:'success',is_error:true,result:"You've hit your 5-hour limit · resets 3:30pm",usage:{input_tokens:1,output_tokens:0}});return;}
  else out({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Echo: '+prompt+' | args: '+args.filter(a=>a.startsWith('--')).join(',')}}});
  out({type:'result',subtype:'success',is_error:false,result:'done',usage:{input_tokens:5,output_tokens:7,cache_read_input_tokens:100}});
});`;
async function fake(){
  const dir=await mkdtemp(join(tmpdir(),'hub-fake-claude-')),script=join(dir,'claude.mjs');await writeFile(script,FAKE);
  const adapter=new ClaudeCodeAdapter(process.execPath,(command,args,options)=>{
    const {spawn}=globalThis.__spawn;return spawn(command,[script,...args],{...options,stdio:['pipe','pipe','pipe']});});
  return {adapter,dir};
}
globalThis.__spawn=await import('node:child_process');
// Do not consult the user's real persisted subscription receipt in unit tests.
const testHome=await mkdtemp(join(tmpdir(),'hub-claude-tests-')),originalHome=process.env.DSH_HOME;
process.env.DSH_HOME=testHome;
test.after(async()=>{if(originalHome===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=originalHome;await rm(testHome,{recursive:true,force:true});});
const user=text=>({role:'user',source:{kind:'user'},content:[{type:'text',text}]});
const collect=async iterable=>{const out=[];for await(const c of iterable)out.push(c);return out;};
const text=chunks=>chunks.filter(c=>c.type==='text-delta').map(c=>c.text).join('');

test('a plain turn streams text, usage and a stop, with built-in tools off and only HUB tools allowed',async()=>{
 const {adapter,dir}=await fake();
 try{
  const chunks=await collect(adapter.stream({model:'sonnet',reasoningEffort:'high',sessionId:'s1',messages:[user('hello')],system:'Be brief.'}));
  assert.match(text(chunks),/^Echo: hello/);
  assert.match(text(chunks),/--tools/);assert.match(text(chunks),/--strict-mcp-config/);assert.match(text(chunks),/--effort/);assert.match(text(chunks),/--system-prompt-file/);
  assert.deepEqual(chunks.find(c=>c.type==='usage').usage,{inputTokens:105,outputTokens:7,cacheReadTokens:100});
  assert.equal(chunks.at(-1).reason.kind,'stop');
  assert.deepEqual(chunks.filter(c=>c.type==='block-start').map(c=>c.blockType),['text']);
  assert.ok(chunks.some(c=>c.type==='block-end'&&c.block.type==='text'));
 }finally{adapter.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a tool call goes to HUB, and its result goes back to the waiting CLI',async()=>{
 const {adapter,dir}=await fake();
 try{
  const tools=[{name:'hub_phone_context',description:'Phone',parameters:{type:'object'}}];
  const ask=[user('please use the tool')];
  const first=await collect(adapter.stream({model:'haiku',sessionId:'s2',messages:ask,tools}));
  assert.equal(first.at(-1).reason.kind,'tool-calls');
  const call=first.find(c=>c.type==='block-end'&&c.block.type==='tool-call').block;
  assert.equal(call.name,'hub_phone_context');assert.equal(call.arguments,'{"q":1}');
  assert.equal(text(first),'Checking. ');
  const history=[...ask,{role:'assistant',source:{kind:'model'},content:[{type:'tool-call',...call}]},
   {role:'user',source:{kind:'tool',callId:call.id},content:[{type:'tool-result',toolCallId:call.id,content:[{type:'text',text:'Moda'}]}]}];
  const second=await collect(adapter.stream({model:'haiku',sessionId:'s2',messages:history,tools}));
  assert.equal(text(second),'Got: Moda');assert.equal(second.at(-1).reason.kind,'stop');
  // Each step reports its own model call, not the CLI's running total for the run.
  assert.deepEqual(first.find(c=>c.type==='usage').usage,{inputTokens:95010,outputTokens:40,cacheReadTokens:90000,cacheWriteTokens:5000});
  assert.deepEqual(second.find(c=>c.type==='usage').usage,{inputTokens:95020,outputTokens:30,cacheReadTokens:95000});
 }finally{adapter.dispose();await rm(dir,{recursive:true,force:true});}
});

test('a crashing CLI ends the turn with a readable error',async()=>{
 const {adapter,dir}=await fake();
 try{
  const chunks=await collect(adapter.stream({model:'haiku',sessionId:'s3',messages:[user('crash now')]}));
  const finish=chunks.at(-1).reason;assert.equal(finish.kind,'error');assert.match(finish.failure.message,/boom/);
 }finally{adapter.dispose();await rm(dir,{recursive:true,force:true});}
});

test('models, reasoning levels and CLI discovery',async()=>{
 const adapter=new ClaudeCodeAdapter('claude');
 assert.deepEqual((await adapter.listModels('claude-code')).map(m=>m.id),CLAUDE_CODE_MODELS.map(m=>m.id));
 const info=await adapter.resolveModel('claude-code','opus');
 assert.equal(info.context.contextWindow,200000);assert.ok(info.reasoning.efforts.some(e=>e.id==='max'));
 assert.equal(findClaude({USERPROFILE:'C:\\Users\\x',PATH:''},p=>p==='C:\\Users\\x\\.local\\bin\\claude.exe','win32'),'C:\\Users\\x\\.local\\bin\\claude.exe');
 assert.equal(findClaude({USERPROFILE:'C:\\Users\\x',PATH:'C:\\tools'},p=>p==='C:\\tools\\claude.exe','win32'),'C:\\tools\\claude.exe');
 assert.equal(findClaude({USERPROFILE:'C:\\Users\\x',PATH:''},()=>false,'win32'),undefined);
 adapter.dispose();
});

test('earlier turns become one prompt; trailing tool results are found',()=>{
 assert.equal(conversationPrompt([user('just this')]),'just this');
 const prompt=conversationPrompt([user('a'),{role:'assistant',content:[{type:'text',text:'b'},{type:'tool-call',name:'t',arguments:'{}'}]},
  {role:'user',source:{kind:'tool'},content:[{type:'tool-result',toolCallId:'x',content:[{type:'text',text:'r'}]}]},user('c')]);
 assert.match(prompt,/User: a[\s\S]*Assistant: b[\s\S]*Assistant called t\(\{\}\)[\s\S]*Tool result: r[\s\S]*User: c/);
 assert.deepEqual(trailingToolResults([user('q'),{role:'user',source:{kind:'tool'},content:[{type:'tool-result',toolCallId:'1'}]}]).map(r=>r.toolCallId),['1']);
 assert.deepEqual(trailingToolResults([user('q')]),[]);
});

test('subscription limits come from the CLI rate-limit event and fit the usage contract',async()=>{
 const {parseClaudeCodeUsage}=await import('../packages/harness-overlay/src/usage-contract.ts');
 // As printed by Claude Code 2.1 for a Pro account.
 const info={status:"allowed_warning",resetsAt:1795154400,rateLimitType:"seven_day",utilization:0.86,overageStatus:"rejected",isUsingOverage:false,
  unifiedWindows:{five_hour:{utilization:0.86,resetsAt:1795010400,status:"allowed"},seven_day:{utilization:0.86,resetsAt:1795154400,status:"allowed_warning",surpassedThreshold:0.75}}};
 const limits=parseClaudeCodeLimits(info,new Date("2026-11-18T12:00:00Z"));
 assert.deepEqual(limits.windows,[{id:"five_hour",usedPercent:86,resetsAt:1795010400,status:"allowed"},{id:"seven_day",usedPercent:86,resetsAt:1795154400,status:"allowed_warning"}]);
 assert.equal(limits.warning,undefined);
 assert.deepEqual(parseClaudeCodeUsage({state:"ready",...limits}).windows.length,2);
 assert.match(parseClaudeCodeLimits({unifiedWindows:{five_hour:{utilization:1,status:"rejected"}}}).warning,/reached this limit/);
 assert.equal(parseClaudeCodeLimits({status:"allowed"}),undefined);
 assert.deepEqual(parseClaudeCodeUsage({state:"waiting"}),{state:"waiting"});
});

test('subscription limit emits typed reset metadata, never invokes configured fallback, and blocks early model probes',async()=>{
 const home=await mkdtemp(join(tmpdir(),'hub-cc-limit-'));const saved=process.env.DSH_HOME;process.env.DSH_HOME=home;
 const dir=await mkdtemp(join(tmpdir(),'hub-fake-claude-')),script=join(dir,'claude.mjs');await writeFile(script,FAKE);
 let launches=0;const asked=[];
 const fallback={route:()=>({provider:'openrouter',model:'z-ai/glm-5.3-flash',reasoningEffort:'low'}),
  async *stream(options){asked.push(options);yield {type:'block-start',index:0,blockType:'text'};yield {type:'text-delta',index:0,text:'Fast answer'};yield {type:'finish',reason:{kind:'stop'}};}};
 const adapter=new ClaudeCodeAdapter(process.execPath,(command,args,options)=>{launches++;return globalThis.__spawn.spawn(command,[script,...args],{...options,stdio:['pipe','pipe','pipe']});},fallback);
 try{
  const first=await collect(adapter.stream({model:'opus',sessionId:'limit',messages:[user('we are out of quota')],system:'Be HUB.'}));
  assert.equal(text(first),'');assert.equal(first.at(-1).reason.kind,'error');
   assert.equal(first.at(-1).reason.failure.code,'subscription-limit');
   assert.equal(first.at(-1).reason.failure.subscriptionLimit.model,'opus');
   assert.ok(first.at(-1).reason.failure.subscriptionLimit.resetsAt>Date.now());
  assert.deepEqual(asked,[],'no paid or alternate subscription route is called');
  assert.equal(first.at(-1).reason.failure.subscriptionLimit.provider,'claude-code');
  assert.ok(claudeCodeBlockedUntil()>Date.now());
  const second=await collect(adapter.stream({model:'opus',sessionId:'limit-2',messages:[user('hello again')]}));
  assert.equal(text(second),'');assert.equal(second.at(-1).reason.failure.code,'subscription-limit');assert.equal(launches,1,'no model probe before the actual reset');
 }finally{adapter.dispose();if(saved===undefined)delete process.env.DSH_HOME;else process.env.DSH_HOME=saved;await rm(dir,{recursive:true,force:true});await rm(home,{recursive:true,force:true});}
});
