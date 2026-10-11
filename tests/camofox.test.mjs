import test from 'node:test';import assert from 'node:assert/strict';
import {CamofoxRuntime,installCamofoxTools,externalWebUrl} from '@minke/harness-overlay/host/camofox.ts';
test('browser accepts public web URLs and rejects script, credential and private-network URLs',()=>{assert.equal(externalWebUrl('https://example.org'),'https://example.org/');for(const url of ['javascript:alert(1)','file:///c:/private','https://name:password@example.org','http://127.0.0.1','http://0x7f000001','http://192.168.1.1','http://[::1]'])assert.throws(()=>externalWebUrl(url));});
test('Camofox tabs are isolated per native task and DELETE carries the required owner body',async()=>{
 const calls=[];const runtime=new CamofoxRuntime({},new AbortController().signal,async(url,options)=>{calls.push({url,method:options.method,body:options.body?JSON.parse(options.body):null});return new Response(JSON.stringify(url.endsWith('/health')?{ok:true,engine:'camoufox'}:url.endsWith('/tabs')?{tabId:'owned-tab'}:{snapshot:'Read page evidence'}));});
 const registered=new Map();const off=installCamofoxTools({register(t){registered.set(t.name,t);return()=>registered.delete(t.name);}},runtime);
 const owner={agent:{id:'one'},signal:new AbortController().signal},other={...owner,agent:{id:'two'}};
 await registered.get('camofox_open').execute({url:'https://example.org'},owner);
 await assert.rejects(registered.get('camofox_snapshot').execute({tabId:'owned-tab'},other),/created by this character/);
 await registered.get('camofox_snapshot').execute({tabId:'owned-tab'},owner);
 await registered.get('camofox_close').execute({tabId:'owned-tab'},owner);
 const request=calls.find(c=>c.method==='DELETE');assert.ok(request.body.userId.startsWith('hub-'));assert.equal(request.url,'http://127.0.0.1:9377/tabs/owned-tab');assert.equal(request.body.userId,calls.find(c=>c.method==='POST').body.userId);
 await assert.rejects(registered.get('camofox_snapshot').execute({tabId:'owned-tab'},owner),/created by this character/);off();assert.equal(registered.size,0);
});

test('Windows startup passes CMD arguments separately and scrubs ambient provider credentials',async()=>{
 const {mkdtemp,writeFile,mkdir,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join,dirname,basename}=await import('node:path');const root=await mkdtemp(join(tmpdir(),'hub-camo-start-'));let ready=false,launch;
 try{await writeFile(join(root,'runtime.json'),JSON.stringify({launcher:'C:\\HUB Tools\\camofox.cmd'}));const runtime=new CamofoxRuntime({async resolveExecutable(){return 'C:/Windows/System32/cmd.exe'},spawn(spec){launch=spec;ready=true;return {done:Promise.resolve({exitCode:0,signal:null})}}},new AbortController().signal,async()=>new Response(JSON.stringify({ok:ready,engine:'camoufox'})),root);await runtime.ensure();assert.deepEqual(launch.argv.slice(1),['/d','/c','C:\\HUB Tools\\camofox.cmd','server','start']);assert.equal(launch.env.CAMOFOX_HOST,'127.0.0.1');assert.equal(launch.env.CAMOFOX_AUTH_MODE,'auto');assert.equal(launch.signal.aborted,false);}
 finally{assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-camo-start-'));await rm(root,{recursive:true,force:true});}
});
