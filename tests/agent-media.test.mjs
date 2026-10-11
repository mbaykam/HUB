import test from 'node:test';import assert from 'node:assert/strict';
import {runAgentTurnInHarness} from '../packages/harness-overlay/src/host/agent-turn-control.ts';
import {createAgentTurnRunRequest} from '../packages/harness-overlay/src/agent-turn-contract.ts';
test('a media turn validates encoded admission, preserves its durable receipt, and rejects a changed image on cold recovery',async()=>{
 const media={name:'Photo.png',mediaType:'image/png',data:Buffer.from('fixture').toString('base64')},input={operationId:'image-operation',sessionId:'image-session',text:'Describe this image.',media:[media]};
 assert.deepEqual(createAgentTurnRunRequest(1,input).input,input);assert.throws(()=>createAgentTurnRunRequest(1,{...input,media:[{...media,data:'not-base64'}]}));
 let events=[],prompts=0;const ref={attachmentId:'a'.repeat(64),mediaType:'image/png',bytes:7,width:1,height:1,name:'Photo.png'};
 const controller={async create(){return{sessionId:input.sessionId};},async inspect(){return{events};},async prompt(request){prompts++;assert.equal(request.content[1].type,'image');assert.equal(request.content[1].data,media.data);events=[{type:'turn/start',seq:1,time:1,data:{turn:1}},{type:'user/message',seq:2,time:2,data:{source:{kind:'user',rpcId:request.requestId},content:[{type:'text',text:request.content[0].text},{type:'image',attachment:ref}]}},{type:'assistant/message',seq:3,time:3,data:{turn:1,step:1,message:{role:'assistant',content:[{type:'text',text:'Image received.'}]}}},{type:'turn/end',seq:4,time:4,data:{turn:1,reason:{kind:'completed'}}}];return{accepted:true};}};
 const options={pollIntervalMs:1,prepareMedia:async value=>({input:value,images:[{type:'image',attachment:ref}]})};
 const first=await runAgentTurnInHarness(controller,input,AbortSignal.timeout(2000),options);assert.equal(first.outcome,'completed');assert.equal(prompts,1);
 const cold=await runAgentTurnInHarness(controller,structuredClone(input),AbortSignal.timeout(2000),options);assert.equal(cold.outcome,'completed');assert.equal(prompts,1);
 await assert.rejects(runAgentTurnInHarness(controller,{...input,media:[{...media,data:Buffer.from('different').toString('base64')}]},AbortSignal.timeout(2000),{...options,prepareMedia:async value=>({input:value,images:[{type:'image',attachment:{...ref,attachmentId:'b'.repeat(64)}}]})}),/different input/);assert.equal(prompts,1);
});
