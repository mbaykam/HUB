import test from 'node:test';import assert from 'node:assert/strict';import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,dirname,basename} from 'node:path';import {randomUUID} from 'node:crypto';
import {characterSchema} from '@minke/harness-overlay/character-contract.ts';
import {CharacterStore,CharacterConflict} from '@minke/harness-overlay/host/characters-store.ts';
const seed=()=>{const mainId=randomUUID(),voiceId=randomUUID();const character=(id,name)=>({id,name,avatar:'hub',description:'',instructions:'',route:{provider:'test',model:'model'},tools:{mode:'inherit'},speech:null,delegateTo:null});return {revision:0,mainId,voiceId,bindings:{},characters:[character(mainId,'HUB'),{...character(voiceId,'Conversation'),avatar:'voice',speech:{stt:{engine:'whisper',model:'base.en'},tts:{engine:'kokoro',model:'82m',voice:'af_heart'}},delegateTo:mainId},{...character(randomUUID(),'Devil'),avatar:'devil',route:null}]};};
test('character edits are durable, preserve the unconfigured character and fence concurrent revisions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-character-store-'));try{const store=new CharacterStore(root);await store.load(async()=>seed());const state=store.snapshot();const main=state.characters[0];
 const values=await Promise.allSettled([store.change({action:'save',revision:0,character:{...main,name:'My HUB'}},async()=>{}),store.change({action:'save',revision:0,character:{...main,name:'Stale edit'}},async()=>{})]);assert.equal(values.filter(v=>v.status==='fulfilled').length,1);assert.ok(values.find(v=>v.status==='rejected').reason instanceof CharacterConflict);
 const copy=new CharacterStore(root);await copy.load(async()=>{throw new Error('Must reuse saved state')});assert.equal(copy.snapshot().characters[0].name,'My HUB');assert.equal(copy.snapshot().characters.find(c=>c.name==='Devil').route,null);
 await assert.rejects(store.change({action:'main',revision:1,id:state.characters[2].id},async()=>{}),/Choose a model/);assert.equal(store.snapshot().revision,1);
 await assert.rejects(store.change({action:'delete',revision:1,id:state.mainId},async()=>{}),/Choose another/);assert.equal(store.snapshot().characters.length,3);
 }finally{assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-character-store-'));await rm(root,{recursive:true,force:true});}
});
test('text conversation character does not change the Telegram main assistant',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-character-store-'));try{const store=new CharacterStore(root);await store.load(async()=>seed());const s=store.snapshot();await store.change({action:'select',revision:0,id:s.voiceId,sessionId:'text-chat'},async()=>{});assert.equal(store.selected('text-chat').id,s.voiceId);assert.equal(store.selected('minke-im-telegram-'+ 'a'.repeat(32)).id,s.mainId);assert.equal(store.selected().id,s.mainId);assert.equal(store.selected('constructor').id,s.mainId);
 }finally{assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-character-store-'));await rm(root,{recursive:true,force:true});}
});

test("OpenRouter aliases can be assigned to characters without interpreting them as paths",()=>{const c=seed().characters[0];assert.equal(characterSchema.parse({...c,route:{provider:"openrouter",model:"vendor/model:free"}}).route.model,"vendor/model:free");assert.throws(()=>characterSchema.parse({...c,route:{provider:"openrouter",model:"model with spaces"}}));});

test('an explicit Telegram handoff is durable and isolated to that conversation',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-character-store-'));
 try{const store=new CharacterStore(root);await store.load(async()=>seed());const s=store.snapshot();
 await store.change({action:'select',revision:s.revision,id:s.voiceId,sessionId:'minke-im-telegram-one'},async()=>{});
 const copy=new CharacterStore(root);await copy.load(async()=>{throw Error('Must load saved binding')});
 assert.equal(copy.selected('minke-im-telegram-one').id,s.voiceId);
 assert.equal(copy.selected('minke-im-telegram-two').id,s.mainId);
 assert.equal(copy.selected('new-text-chat').id,s.mainId);
 }finally{assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-character-store-'));await rm(root,{recursive:true,force:true});}
});
