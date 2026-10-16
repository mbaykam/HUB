import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {installMobileModels} from '../packages/harness-overlay/src/client/host/mobile-models.ts';
const flush=()=>new Promise(r=>setTimeout(r,20));
test('character model options use discovered levels and preserve drafts after a rejected selection',async()=>{
 const dom=new JSDOM('<main></main>',{url:'https://hub.test',pretendToBeVisual:true}),view=dom.window,root=view.document;
 view.HTMLDialogElement.prototype.showModal=function(){this.open=true};view.HTMLDialogElement.prototype.close=function(){this.open=false};
 view.ResizeObserver=class{observe(){}disconnect(){}};
 const model={provider:'openrouter',id:'fixture/model',name:'Fixture model',input:['text','image'],tools:true,reasoning:true,contextWindow:200000,maxTokens:64000,efforts:[{id:'low',name:'Low'},{id:'ultra',name:'Ultra'}],enabled:true,source:'provider',supportedParameters:['temperature','max_tokens','reasoning','top_p'],editableParameters:['temperature','max_tokens','reasoning_effort'],defaults:{temperature:.7}},commands=[];let reject=true,selected;
 view.fetch=async(_url,init)=>{if(init.body){commands.push(JSON.parse(init.body));return Response.json(reject?{error:'unavailable'}:{available:true},{status:reject?409:200});}return Response.json({providers:[{id:'openrouter',name:'OpenRouter'}],models:[model],stale:false,refreshedAt:null});};
 const dispose=installMobileModels(root.querySelector('main'),root,()=>undefined,{choose:(m,effort,parameters)=>selected={model:m.id,effort,parameters}});
 try{root.querySelector('[data-hub-models-launcher]').click();await flush();root.querySelector('article details').open=true;const effort=root.querySelector('[aria-label="Reasoning for Fixture model"]');assert.deepEqual([...effort.options].map(o=>o.value),['','low','ultra']);effort.value='ultra';effort.dispatchEvent(new view.Event('change'));const output=root.querySelector('[aria-label="Output tokens for Fixture model"]');output.value='12000';output.dispatchEvent(new view.Event('input'));const temp=root.querySelector('[aria-label="Temperature for Fixture model"]');temp.value='.4';temp.dispatchEvent(new view.Event('input'));assert.match(root.querySelector('article').textContent,/top_p/);const choose=()=>[...root.querySelectorAll('button')].find(b=>b.textContent==='Use model');choose().click();await flush();assert.equal(root.querySelector('[aria-label="Output tokens for Fixture model"]').value,'12000');assert.equal(root.querySelector('[aria-label="Reasoning for Fixture model"]').value,'ultra');assert.equal(selected,undefined);reject=false;choose().click();await flush();assert.deepEqual(selected,{model:'fixture/model',effort:'ultra',parameters:{temperature:.4,maxTokens:12000}});assert.equal(commands.at(-1).maxTokens,12000);assert.equal(commands.at(-1).reasoningEffort,'ultra');
 }finally{dispose();view.close();}
});
