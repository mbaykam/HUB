import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {createRequire} from 'node:module';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createSpeechPreviewHandler} from '../../packages/harness-overlay/src/host/speech-preview.ts';
import {defaultKnowledgeSettings} from '../../packages/harness-overlay/src/knowledge-contract.ts';

const output=process.argv[2];await mkdir(output,{recursive:true});
const bundle=await build({stdin:{contents:'import memoryStyles from "./packages/harness-overlay/src/client/host/mobile-memory.css";export {memoryStyles};export {installMobileHubs} from "./packages/harness-overlay/src/client/host/mobile-hubs.ts";export {installCharactersClient} from "./packages/harness-overlay/src/client/host/mobile-characters.ts";export {installKnowledgeControls} from "./packages/harness-overlay/src/client/host/mobile-knowledge.ts"',resolveDir:process.cwd(),loader:'ts'},loader:{'.css':'text'},write:false,bundle:true,format:'esm',platform:'browser'});
const python=process.env.HUB_VOICE_PYTHON??join(homedir(),'.dsh','runtimes','pipecat',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const speech=JSON.parse(execFileSync(python,['packages/harness-overlay/voice/speech_settings.py'],{encoding:'utf8',windowsHide:true,timeout:30000}));
const mainId='00000000-0000-4000-8000-000000000001',voiceId='00000000-0000-4000-8000-000000000002',devilId='00000000-0000-4000-8000-000000000003';
const localSpeech={stt:{engine:'whisper',model:'small',language:'auto'},tts:{engine:'bilingual',model:'kokoro-piper',voice:'am_echo',turkishVoice:'tr_TR-dfki-medium',language:'auto'}};
let characters={revision:4,mainId,voiceId,bindings:{},characters:[{id:mainId,name:'HUB',avatar:'hub',description:'Main assistant',instructions:'Existing main instructions',route:{provider:'openrouter',model:'anthropic/claude-opus-5.5'},speech:null,tools:{mode:'inherit'},delegateTo:null},{id:voiceId,name:'Conversation',avatar:'voice',description:'Fast voice assistant',instructions:'Existing voice instructions',route:{provider:'openrouter',model:'inclusionai/ling-3.0-flash'},speech:localSpeech,tools:{mode:'inherit'},delegateTo:mainId},{id:devilId,name:'Devil',avatar:'devil',description:'Configure later',instructions:'',route:null,speech:null,tools:{mode:'inherit'},delegateTo:mainId}]};
let knowledge={secondBrain:true,enabled:true,status:'budget-paused',vault:'Local Obsidian vault',settings:{...defaultKnowledgeSettings},todayEstimatedCost:.1,monthEstimatedCost:.2,counts:{queued:3,working:0,review:0,done:7,failed:0},jobs:[],notes:12,embedding:'Local multilingual search',historyArchivesReady:false};
let previews=0,spawns=0;
const preview=createSpeechPreviewHandler({python:'unused',script:'unused',signal:new AbortController().signal,subprocess:{resolveExecutable(){throw Error('Inference forbidden');},spawn(){spawns++;throw Error('Inference forbidden');}},catalog:async()=>speech,reject:()=>undefined});
const json=(res,value)=>{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify(value));};
const server=createServer(async(req,res)=>{
 if(req.url==='/ui.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(bundle.outputFiles[0].text);return;}
 if(req.url==='/api/hub/voice/preview'){previews++;await preview(req,res);return;}
 if(req.url==='/api/hub/voice/catalog'){json(res,{speech});return;}
 if(req.url==='/api/hub/voice/status'){json(res,{enabled:true,busy:false});return;}
 if(req.url==='/api/hub/voice/diagnostics'){json(res,{active:false});return;}
 if(req.url==='/api/hub/characters'){
  if(req.method==='POST'){let text='';for await(const chunk of req)text+=chunk;const command=JSON.parse(text);assert.equal(command.action,'save');characters={...characters,revision:characters.revision+1,characters:characters.characters.map(c=>c.id===command.character.id?command.character:c)};}
  json(res,{...characters,tools:[{name:'camofox_search',description:'Search the web'}]});return;
 }
 if(req.url==='/api/hub/memory'){
  if(req.method==='POST'){let text='';for await(const chunk of req)text+=chunk;const command=JSON.parse(text);assert.equal(command.action,'settings');knowledge={...knowledge,settings:command.settings};}
  json(res,knowledge);return;
 }
 if(req.url==='/api/hub/voice/client.js'){res.writeHead(200,{'content-type':'text/javascript'});res.end(`export function createVoiceClient(options){return{async start(id){window.startedWith=id;options.onSession('voice-test');options.onState('listening');},async stop(){options.onState('idle');},mute(){},async play(){}}}`);return;}
 res.writeHead(200,{'content-type':'text/html'});res.end(`<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><style>body{margin:0;background:#121827;color:#eef;font:16px system-ui}[data-composer-seat]{padding:20px;max-width:650px;margin:auto}textarea{width:100%;box-sizing:border-box;min-height:80px}#settings{margin:24px}</style><main data-slot=conversation><div data-phase=hero><div data-composer-seat><div data-slot=conversation.composer.bar><textarea aria-label="Native HUB text"></textarea></div></div></div></main><aside id=settings></aside><button id=characters>Character settings</button>`);
});server.listen(0,'127.0.0.1');await once(server,'listening');
const {chromium}=createRequire(import.meta.url)(process.env.HUB_UI_QA_PLAYWRIGHT??'playwright');
let browser;
try{
 browser=await chromium.launch({channel:'chrome',headless:true});const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.evaluate(async knowledge=>{
  document.documentElement.setAttribute('data-minke-mobile-web','');document.body.setAttribute('data-ds-dark-theme','');
  const module=await import('/ui.js');const style=document.createElement('style');style.textContent=module.memoryStyles;document.head.append(style);window.current=undefined;
  const ctx={sessions:{list:{getSnapshot:()=>({current:window.current,byId:{},phase:'ready'}),subscribe(fn){window.changed=fn;return()=>{};}},open(id){window.current=id;document.querySelector('[data-phase]').setAttribute('data-phase','active');window.changed?.();},clear(){window.current=undefined;document.querySelector('[data-phase]').setAttribute('data-phase','hero');window.changed?.();}}};
  ctx.uiWorkspace={startSession(){}};module.installMobileHubs(ctx);module.installCharactersClient(ctx);module.installKnowledgeControls(document.querySelector('#settings'),document,knowledge);
  document.querySelector('#characters').onclick=()=>window.dispatchEvent(new Event('hub:characters-open'));
 },knowledge);
 await page.locator('[data-voice-start]:not(:disabled)').waitFor();
 assert.equal(await page.locator('[data-hub-character-tab]').count(),0);
 assert.match(await page.locator('[data-hub-text-heading]').textContent(),/Write to HUB/);
 await page.screenshot({path:output+'/home.png'});
 await page.locator('#characters').click();await page.locator(`[data-character-id="${voiceId}"]`).click();
 await page.getByRole('tab',{name:'Voice',exact:true}).click();await page.locator('.hub-speech-voices article').first().waitFor();
 await page.waitForFunction(()=>[...document.querySelectorAll('.hub-speech-voices button:nth-child(2)')].every(b=>!b.disabled),null,{timeout:60000});
 const count=await page.locator('.hub-speech-voices article').count();assert.equal(count,28);
 const delay=async name=>{
  await page.evaluate(()=>{window.clickedAt=0;window.playedAt=0;document.addEventListener('click',()=>{window.clickedAt=performance.now();},{capture:true,once:true});document.addEventListener('playing',()=>{window.playedAt=performance.now();},{capture:true,once:true});});
  const before=previews;await page.getByRole('button',{name,exact:true}).click();await page.waitForFunction(()=>window.playedAt>0);
  assert.equal(previews,before,'A tap must make no network request');const ms=await page.evaluate(()=>window.playedAt-window.clickedAt);assert.ok(ms<500,`Slow playback ${ms}ms`);return ms;
 };
 const englishMs=await delay('Listen to Echo · American · male'),turkishMs=await delay('▶ Türkçe · DFKI voice');
 await page.screenshot({path:output+'/voice.png'});
 await page.getByRole('tab',{name:'Profile',exact:true}).click();await page.locator('[data-character-pane="Profile"] input').nth(1).fill('Edited across tabs');
 await page.getByRole('tab',{name:'Model',exact:true}).click();assert.match(await page.locator('[data-character-pane="Model"]').innerText(),/ling-3.0-flash/);
 await page.getByRole('button',{name:'Save character',exact:true}).click();await page.locator(`[data-character-id="${voiceId}"]`).waitFor();
 assert.equal(characters.characters.find(c=>c.id===voiceId).description,'Edited across tabs');assert.deepEqual(characters.characters.find(c=>c.id===voiceId).speech,localSpeech);assert.equal(characters.characters.find(c=>c.id===mainId).route.model,'anthropic/claude-opus-5.5');
 await page.getByRole('button',{name:'Done',exact:true}).click();
 await page.getByRole('button',{name:'Knowledge AI ayarları',exact:true}).click();assert.equal(await page.getByRole('tab',{name:'Genel',exact:true}).getAttribute('aria-selected'),'true');
 assert.equal(await page.getByLabel('PWA yazılı sohbetleri',{exact:true}).isVisible(),false);
 await page.getByLabel('Ne zaman çalışsın?',{exact:true}).selectOption('review');await page.getByRole('tab',{name:'Notlar',exact:true}).click();await page.getByLabel('Notların dili',{exact:true}).selectOption('en');
 await page.screenshot({path:output+'/knowledge.png'});await page.getByRole('button',{name:'Ayarları kaydet',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-knowledge-menu] footer span')?.textContent==='Ayarlar kaydedildi');
 assert.equal(knowledge.settings.mode,'review');assert.equal(knowledge.settings.language,'en');assert.equal(knowledge.settings.model,defaultKnowledgeSettings.model);assert.equal(knowledge.settings.dailyBudget,.1);
 await page.getByRole('button',{name:'Kapat',exact:true}).click();await page.locator('[data-voice-start]').click();await page.getByRole('button',{name:'End voice'}).waitFor();
 assert.equal(await page.locator('[data-voice-shared-form]').count(),0);assert.equal(await page.getByRole('textbox',{name:'Native HUB text'}).isVisible(),true);assert.equal(await page.evaluate(()=>window.startedWith),undefined);
 await page.getByRole('button',{name:'Open live conversation'}).click();await page.locator('[data-hub-voice-chat]').waitFor();assert.equal(await page.getByRole('textbox',{name:'Native HUB text'}).isVisible(),false);await page.getByRole('button',{name:'Write to HUB',exact:true}).click();assert.equal(await page.getByRole('button',{name:'End voice'}).isVisible(),true);await page.getByRole('button',{name:'End voice'}).click();
 for(const width of [320,390,768]){await page.setViewportSize({width,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));}
 assert.equal(spawns,0);assert.deepEqual(errors,[]);const result={englishMs,turkishMs,voices:count,previewRequests:previews,inferenceSpawns:spawns,channels:'Separate Conversation voice and HUB text',settingsSavedAcrossTabs:true,errors};await writeFile(output+'/result.json',JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{await browser?.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
