import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ClaudeCodeAdapter,findClaude,conversationPrompt,trailingToolResults,CLAUDE_CODE_MODELS} from '../packages/harness-overlay/src/host/claude-code-provider.ts';

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
    out({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Checking. '}}});
    const result=await rpc({jsonrpc:'2.0',id:3,method:'tools/call',params:{name:tools[0].name,arguments:{q:1}}});
    out({type:'stream_event',event:{type:'content_block_delta',delta:{type:'text_delta',text:'Got: '+result.result.content[0].text}}});
  }else if(prompt.includes('crash')){process.stderr.write('boom');process.exit(3);}
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
