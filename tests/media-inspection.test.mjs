import test from 'node:test';
import assert from 'node:assert/strict';
import {publicMediaUrl,MediaInspection,installMediaInspection} from '../packages/harness-overlay/src/host/media-inspection.ts';
import {KnowledgeStore} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {mkdtemp,rm,readdir,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Readable} from 'node:stream';

test('the staged media worker matches the source used by the native tool',async()=>{
 const source=new URL('../packages/harness-overlay/voice/media_inspect.py',import.meta.url),staged=new URL('../runtime/host/node_modules/@lencx/minke-harness-overlay/voice/media_inspect.py',import.meta.url);
 assert.deepEqual(await readFile(staged),await readFile(source),'The release must include the real media worker, not only its JavaScript caller');
});

test('media links are canonical public platforms, without tracking, credentials or arbitrary fetch targets',()=>{
 assert.equal(publicMediaUrl('https://www.instagram.com/reel/DeQdTUlAnqB/?xtok=tracking'),'https://www.instagram.com/reel/DeQdTUlAnqB/');
 assert.equal(publicMediaUrl('https://youtu.be/abcdefghijk?si=track'),'https://www.youtube.com/watch?v=abcdefghijk');
 for(const url of ['http://127.0.0.1/video.mp4','file:///private.mp4','https://instagram.com.evil.test/reel/abc','https://u:p@instagram.com/reel/abc','https://instagram.com/accounts/login','https://example.org/video.mp4'])assert.throws(()=>publicMediaUrl(url));
});

test('inspection saves native evidence metadata and cleans only its own temporary files',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-media-evidence-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new KnowledgeStore(join(root,'vault'),join(root,'state'));await store.initialize();const asset=await store.assets.save(Buffer.from('synthetic media original'),'test.mp4'),calls=[];
 const process={resolveExecutable:async p=>p,spawn(spec){const job=JSON.parse(spec.argv.at(-1));calls.push(job);const bytes=Buffer.from([255,216,255,217]);const ready=writeFile(join(job.outDir,'frame-0.jpg'),bytes);return {stdout:Readable.from((async function*(){await ready;yield JSON.stringify({ok:true,frames:[{file:'frame-0.jpg',seconds:4}],transcript:[{start:4,end:5,text:'Synthetic speech'}],clip:{start:4,end:6},coverage:'sampled'});})()),done:ready.then(()=>({exitCode:0})),terminate(){},waitForExit:async()=>true};}};
 const inspector=new MediaInspection(store,process);const result=await inspector.inspect({assetId:asset.id,startSeconds:4,durationSeconds:2,transcribe:false},AbortSignal.timeout(5000));assert.equal(result.report.observed,true);assert.equal(result.images[0].seconds,4);assert.equal(result.report.transcript[0].text,'Synthetic speech');assert.equal(calls[0].transcribe,false);assert.deepEqual(await readdir(inspector.root),[]);assert.equal((await store.assets.read(asset.path)).bytes.toString(),'synthetic media original');
 await assert.rejects(inspector.inspect({url:'https://example.org/'},AbortSignal.timeout(5000)),/Instagram/);await assert.rejects(inspector.inspect({assetId:asset.id,durationSeconds:900},AbortSignal.timeout(5000)),/120/);
});

test('blocked media does not claim to have observed frames, and character permission checks precede inspection',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-media-denied-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new KnowledgeStore(join(root,'vault'),join(root,'state'));await store.initialize();let launched=0;
 const inspector=new MediaInspection(store,{resolveExecutable:async p=>p,spawn(){launched++;return {stdout:Readable.from([JSON.stringify({ok:false})]),done:Promise.resolve({exitCode:1}),terminate(){},waitForExit:async()=>true};}});
 const result=await inspector.inspect({url:'https://www.instagram.com/reel/abc/'},AbortSignal.timeout(5000));assert.equal(result.report.observed,false);assert.equal(result.images.length,0);assert.match(result.report.detail,/Attach an MP4/);
 const events=new Map(),tools=new Map(),ctx={hubCharacters:{effectiveCharacter:()=>({id:'restricted',tools:{mode:'allow',names:[]}})},on:(name,handler)=>{events.set(name,handler);return()=>{};}};const off=installMediaInspection(ctx,store,Promise.resolve());t.after(off);const agent={id:'hub-eval-media',session:{header:{id:'hub-eval-media'}},ctx:{tools:{register(tool){tools.set(tool.name,tool);return()=>tools.delete(tool.name);}}}};events.get('agent/created')({agent});await assert.rejects(tools.get('hub_media_inspect').execute({url:'https://www.instagram.com/reel/abc/'},{signal:AbortSignal.timeout(5000)}),/disabled/);assert.equal(launched,1);
});

test('media images survive JSON result normalization, respect final filters and stay out of text-only model context',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-media-finalize-'));t.after(()=>rm(root,{recursive:true,force:true}));const store=new KnowledgeStore(join(root,'vault'),join(root,'state'));await store.initialize();const original=MediaInspection.prototype.inspect;t.after(()=>{MediaInspection.prototype.inspect=original;});MediaInspection.prototype.inspect=async()=>({report:{observed:true,source:'synthetic-asset',frames:[{index:0,seconds:1}],transcript:[]},images:[{data:Buffer.from([255,216,255,217]),seconds:1}]});
 const events=new Map(),tools=new Map();let vision=true,saved=0;const ctx={on:(name,handler)=>{events.set(name,handler);return()=>{};},llm:{resolveModelInfo:async()=>({inputModalities:vision?['text','image']:['text']})},attachments:{saveImage:async()=>{saved++;return {attachmentId:'frame-proof',mediaType:'image/jpeg'};}}};const off=installMediaInspection(ctx,store,Promise.resolve());t.after(off);const agent={id:'hub-eval-frame',session:{header:{id:'hub-eval-frame'},requestHeader:()=>({config:{provider:'qa',model:'scripted'}})},ctx:{tools:{register(tool){tools.set(tool.name,tool);return()=>{};}}}};events.get('agent/created')({agent});const tool=tools.get('hub_media_inspect'),exec={signal:AbortSignal.timeout(5000)},args={assetId:'a'.repeat(64)};
 const value=await tool.execute(args,exec),clone=structuredClone(value),blocks=tool.finalizeContent(exec,{value:clone,content:tool.output.render(args,clone),isError:false});assert.equal(blocks.filter(b=>b.type==='image').length,1);assert.equal(saved,1);const filtered=await tool.execute(args,exec);assert.equal(tool.finalizeContent(exec,{value:filtered,content:[{type:'text',text:'Filtered'}],isError:false}),undefined);
 vision=false;const textOnly=await tool.execute(args,exec);assert.equal(textOnly.framesDelivered,0);assert.match(textOnly.visualLimitation,/NOT provided/);assert.equal(saved,2,'Text-only mode must not attach another image');
});
