import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {SharedSpeechSettings,SpeechSettingsConflict} from '../packages/harness-overlay/src/host/speech-settings.ts';
import {characterSpeech} from '../packages/harness-overlay/src/speech-settings-contract.ts';
const speech={stt:{engine:'nemotron',model:'3.5-560ms',language:'auto'},tts:{engine:'supertonic',model:'supertonic-3',voice:'F5',language:'auto',steps:6}};
test('characters only override the voice; global recognition, engine, language and quality win',()=>{
 const legacy={stt:{engine:'whisper',model:'base.en',language:'en'},tts:{...speech.tts,voice:'M2',language:'tr',steps:4}};
 const result=characterSpeech(speech,legacy);assert.deepEqual(result,{...speech,tts:{...speech.tts,voice:'M2'}});assert.equal(legacy.tts.steps,4);
 assert.deepEqual(characterSpeech(speech,{stt:legacy.stt,tts:{engine:'kokoro',model:'82m',voice:'af_heart'}}),speech);
 assert.deepEqual(characterSpeech(speech,null),speech);result.stt.language='tr';assert.equal(speech.stt.language,'auto');
});
test('global speech seeds once, fences stale edits, validates before writing and preserves an admitted call snapshot',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-speech-'));
 try{const store=new SharedSpeechSettings(root);await store.load(()=>speech);const call=characterSpeech(store.snapshot().speech,{...speech,tts:{...speech.tts,voice:'F2'}});
 const [a,b]=await Promise.allSettled([store.change({revision:0,speech:{...speech,tts:{...speech.tts,steps:4}}},()=>{}),store.change({revision:0,speech},()=>{})]);assert.equal(a.status,'fulfilled');assert.ok(b.reason instanceof SpeechSettingsConflict);assert.equal(call.tts.steps,6);assert.equal(call.tts.voice,'F2');
 const before=await readFile(join(root,'speech-settings.json'),'utf8');await assert.rejects(store.change({revision:1,speech},()=>{throw Error('Not installed')}));assert.equal(await readFile(join(root,'speech-settings.json'),'utf8'),before);
 const resumed=new SharedSpeechSettings(root);await resumed.load(()=>{throw Error('Do not reseed when voice character changes')});assert.equal(resumed.snapshot().speech.tts.steps,4);
 }finally{assert.equal(dirname(root),tmpdir());await rm(root,{recursive:true,force:true});}
});
