import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {installInstructionEditor} from '../packages/harness-overlay/src/client/preferences/InstructionSettings.tsx';

test('instruction editor shows real shared scope and saves to the character or curator owner',async()=>{
 const dom=new JSDOM('<main/>',{url:'https://hub.test/'}),root=dom.window.document,calls=[];
 const character={id:'mira',name:'Mira',role:'Voice',route:{provider:'openai-codex',model:'gpt-6-luna'},instructions:{id:'character:mira',name:'Mira instructions',path:'characters.json → instructions',content:'Mira original instructions',hash:'char-hash',editable:true,scope:'Mira only'}};
 let data={shared:[{id:'SOUL.md',name:'SOUL.md',path:'instructions/SOUL.md',content:'Shared rules',hash:'soul-hash',editable:true,scope:'All conversational characters'}],characters:[character]};
 const curator={provider:'openai-codex',model:'gpt-6-luna',reasoningEffort:'minimal',path:'settings.json',instructions:'Curator rules',hash:'curator-hash',builtIn:'<script>this is literal text</script>'};
 dom.window.fetch=async(url,options)=>{calls.push({url,options});const body=options.body&&JSON.parse(options.body);if(body?.id==='character:mira')character.instructions={...character.instructions,content:body.content,hash:'new-character-hash'};if(body?.action==='instructions')curator.instructions=body.instructions;return {ok:true,json:async()=>url.includes('view=instructions')?curator:url.includes('/api/hub/memory')?{}:data};};
 const dispose=installInstructionEditor(root.querySelector('main'),root,()=>undefined);
 try{await setImmediate();await setImmediate();assert.match(root.querySelector('article').textContent,/gpt-6-luna/);const select=root.querySelector('select');select.value='character:mira';select.dispatchEvent(new dom.window.Event('change'));const editor=root.querySelector('textarea');editor.value='New Mira instructions';editor.dispatchEvent(new dom.window.Event('input'));root.querySelector('button').click();await setImmediate();await setImmediate();const save=calls.find(c=>c.options.body&&JSON.parse(c.options.body).id==='character:mira');assert.deepEqual(JSON.parse(save.options.body),{id:'character:mira',hash:'char-hash',content:'New Mira instructions'});assert.equal(save.options.headers['x-hub-instructions'],'1');
 select.value='curator';select.dispatchEvent(new dom.window.Event('change'));editor.value='New curator rules';editor.dispatchEvent(new dom.window.Event('input'));root.querySelector('button').click();await setImmediate();await setImmediate();const saveCurator=calls.find(c=>c.options.body&&JSON.parse(c.options.body).action==='instructions');assert.deepEqual(JSON.parse(saveCurator.options.body),{action:'instructions',hash:'curator-hash',instructions:'New curator rules'});assert.equal(root.querySelector('script'),null);assert.match(root.querySelector('pre').textContent,/<script>/);
 }finally{dispose();dom.window.close();}
});
