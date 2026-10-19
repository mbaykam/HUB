import test from 'node:test';import assert from 'node:assert/strict';
import {createServer} from 'node:http';import {once} from 'node:events';import {randomUUID} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,dirname,basename} from 'node:path';
import {KnowledgeAssets} from '../packages/harness-overlay/src/host/knowledge-assets.ts';
import {createUploadsHandler} from '../packages/harness-overlay/src/host/uploads.ts';
import {prepareVoiceShare} from '../packages/harness-overlay/src/host/voice-media.ts';
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aUkcAAAAASUVORK5CYII=','base64');
async function fixture(t){
 const root=await mkdtemp(join(tmpdir(),'hub-eval-uploads-')),assets=new KnowledgeAssets(join(root,'vault'),join(root,'state'));let imageSaves=0;
 const handler=createUploadsHandler({assets,reject:req=>req.headers.cookie==='fixture=1'?undefined:401,session:async id=>id==='hub-eval-upload',saveImages:async items=>{imageSaves++;assert.deepEqual(items[0].data,png);return [{attachmentId:'a'.repeat(64),mediaType:'image/png',width:1,height:1,bytes:png.length}];}});
 const server=createServer((req,res)=>void handler(req,res));server.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}/api/hub/uploads`;
 t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-eval-uploads-'));await rm(root,{recursive:true,force:true});});
 const upload=(data=png,id=randomUUID(),name='Fixture.png',headers={})=>fetch(url,{method:'POST',headers:{cookie:'fixture=1','x-hub-upload':'1','x-hub-upload-id':id,'x-hub-session':'hub-eval-upload','x-hub-file-name':encodeURIComponent(name),...headers},body:data});
 return {assets,url,upload,get imageSaves(){return imageSaves;}};
}
test('real binary uploads retain originals, native images and replay-safe session-owned receipts after restart',async t=>{
 const f=await fixture(t),id=randomUUID(),responses=await Promise.all([f.upload(png,id),f.upload(png,id)]);assert.deepEqual(responses.map(r=>r.status),[200,200]);assert.equal(f.imageSaves,1);
 const result=await responses[0].json();assert.equal(result.image,true);assert.match(result.text,new RegExp(id));assert.doesNotMatch(result.text,/C:\\|base64/);
 const cold=new KnowledgeAssets(f.assets.vault,f.assets.root),receipt=await cold.upload(id);assert.equal(receipt.sessionId,'hub-eval-upload');assert.equal(receipt.image.attachmentId,'a'.repeat(64));
 const original=await cold.get(receipt.assetId);assert.deepEqual(await readFile(await cold.path(original.path)),png);
 const download=await fetch(f.url+'/'+id,{headers:{cookie:'fixture=1'}});assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),/^attachment;/);assert.equal(download.headers.get('x-content-type-options'),'nosniff');assert.deepEqual(Buffer.from(await download.arrayBuffer()),png);
 assert.equal((await f.upload(Buffer.from('different'),id,'Other.txt')).status,409);
 assert.equal((await cold.uploadedAssets('another-session',result.text)).length,0);assert.equal((await cold.uploadedAssets('hub-eval-upload',result.text))[0].id,original.id);
});
test('documents have bounded untrusted previews, unknown files remain honest, and transport guards fail closed',async t=>{
 const f=await fixture(t),text=await (await f.upload(Buffer.from('A real bilingual fixture: merhaba / hello.'),randomUUID(),'Notes.txt')).json();assert.match(text.text,/BEGIN UNTRUSTED FILE CONTENT/);assert.match(text.text,/merhaba \/ hello/);
 const unknown=await (await f.upload(Buffer.from('fixture binary'),randomUUID(),'Original.bin')).json();assert.match(unknown.text,/no local text preview/);assert.equal(unknown.image,false);
 assert.equal((await f.upload(png,randomUUID(),'X.png',{cookie:''})).status,401);assert.equal((await f.upload(png,randomUUID(),'X.png',{'sec-fetch-site':'cross-site'})).status,403);
 assert.equal((await f.upload(png,randomUUID(),'X.png',{'x-hub-upload':'0'})).status,403);assert.equal((await f.upload(png,randomUUID(),'X.png',{'x-hub-session':'other'})).status,404);
 assert.equal((await f.upload(Buffer.alloc(0))).status,400);assert.equal((await f.upload(Buffer.alloc(25_000_001),'f'.repeat(36))).status,400);
 assert.equal((await f.upload(Buffer.alloc(25_000_001))).status,413);assert.equal((await fetch(f.url+'/not-a-receipt',{headers:{cookie:'fixture=1'}})).status,404);
});
test('voice sharing validates ownership and HUB vision before admitting a text-only Mira request',async t=>{
 const f=await fixture(t),result=await (await f.upload()).json();let modalities=['text','image'];
 const ctx={get:name=>name==='hubKnowledgeAssets'?{assets:f.assets}:undefined,hubCharacters:{voiceTarget:()=>({name:'HUB',route:{provider:'fixture',model:'vision'}})},llm:{resolveModelInfo:async()=>({inputModalities:modalities})}};
 const text=await prepareVoiceShare(ctx,'hub-eval-upload',[result.id],'Read the label');assert.match(text,/Read the label/);assert.match(text,/hub_task/);assert.match(text,/HUB_ATTACHMENT/);assert.doesNotMatch(text,/attachmentId|base64/);
 await assert.rejects(prepareVoiceShare(ctx,'other',[result.id],''),/another conversation/);modalities=['text'];await assert.rejects(prepareVoiceShare(ctx,'hub-eval-upload',[result.id],''),/vision model/);
 const doc=await (await f.upload(Buffer.from('test file'),randomUUID(),'Doc.txt')).json();assert.match(await prepareVoiceShare(ctx,'hub-eval-upload',[doc.id],''),/test file/);
});
