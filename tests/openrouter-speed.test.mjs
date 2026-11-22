import test from 'node:test';
import assert from 'node:assert/strict';
import {withOpenRouterSpeed,installOpenRouterSpeed,OPENROUTER_CHAT_URL} from '../packages/harness-overlay/src/host/openrouter-speed.ts';

test('OpenRouter chat requests ask for the fastest host; everything else is untouched',async()=>{
 const body=JSON.stringify({model:'z-ai/glm-5.3-flash',messages:[],stream:true});
 assert.deepEqual(JSON.parse(withOpenRouterSpeed(OPENROUTER_CHAT_URL,{method:'POST',body}).body).provider,{sort:'throughput'});
 // A request that already chose its hosts keeps its choice.
 assert.equal(withOpenRouterSpeed(OPENROUTER_CHAT_URL,{method:'POST',body:JSON.stringify({model:'x',provider:{order:['Together']}})}),undefined);
 assert.equal(withOpenRouterSpeed('https://openrouter.ai/api/v1/models',{method:'GET'}),undefined);
 assert.equal(withOpenRouterSpeed('https://api.unlid.ai/v1/chat/completions',{method:'POST',body}),undefined);
 assert.equal(withOpenRouterSpeed(OPENROUTER_CHAT_URL,{method:'POST',body:'not json'}),undefined);

 const seen=[];const target={fetch:async(input,init)=>{seen.push([String(input),init?.body]);return new Response('ok');}};
 const off=installOpenRouterSpeed(target);
 await target.fetch(OPENROUTER_CHAT_URL,{method:'POST',body});
 await target.fetch(new URL('https://example.com/a'),{method:'POST',body});
 assert.match(seen[0][1],/"provider":\{"sort":"throughput"\}/);assert.equal(seen[1][1],body);
 off();await target.fetch(OPENROUTER_CHAT_URL,{method:'POST',body});assert.equal(seen[2][1],body);
});
