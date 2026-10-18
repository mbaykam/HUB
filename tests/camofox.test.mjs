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

test('startup keeps CMD arguments separate and binds the service to loopback',async()=>{
 const {mkdtemp,writeFile,mkdir,rm}=await import('node:fs/promises');const {tmpdir}=await import('node:os');const {join,dirname,basename}=await import('node:path');const root=await mkdtemp(join(tmpdir(),'hub-camo-start-'));let ready=false,launch;
 try{const launcher=join(root,'HUB Tools','camofox.cmd');await writeFile(join(root,'runtime.json'),JSON.stringify({launcher}));const runtime=new CamofoxRuntime({async resolveExecutable(){return join(root,'cmd.exe')},spawn(spec){launch=spec;ready=true;return {done:Promise.resolve({exitCode:0,signal:null})}}},new AbortController().signal,async()=>new Response(JSON.stringify({ok:ready,engine:'camoufox'})),root);await runtime.ensure();assert.deepEqual(launch.argv.slice(1),['/d','/c',launcher,'server','start']);assert.equal(launch.env.CAMOFOX_HOST,'127.0.0.1');assert.equal(launch.env.CAMOFOX_AUTH_MODE,'auto');assert.equal(launch.signal.aborted,false);}
 finally{assert.equal(dirname(root),tmpdir());assert.ok(basename(root).startsWith('hub-camo-start-'));await rm(root,{recursive:true,force:true});}
});

test('form actions require observed references, refresh evidence, and cannot cross task ownership',async()=>{
 const calls=[],registered=new Map(),runtime={request:async(path,method,body)=>{calls.push({path,method,body});if(path==='/tabs')return {tabId:'form'};if(path.includes('/snapshot'))return {snapshot:'- textbox "Query" [e1]\n- button "Find" [e2]'};return {ok:true};}},off=installCamofoxTools({register(tool){registered.set(tool.name,tool);return()=>registered.delete(tool.name);}},runtime),exec={agent:{id:'qa-owner'},signal:AbortSignal.timeout(5000)};
 try{const run=(name,args,e=exec)=>registered.get('camofox_'+name).execute(args,e);await run('open',{url:'https://example.org'});
 await assert.rejects(run('type',{tabId:'form',ref:'e1',text:'synthetic query'}),/snapshot/);await run('snapshot',{tabId:'form'});
 await assert.rejects(run('click',{tabId:'form',ref:'e999'}),/snapshot/);const filled=await run('type',{tabId:'form',ref:'e1',text:'synthetic query'});assert.match(filled.snapshot,/Find/);assert.equal(calls.find(c=>c.path.endsWith('/type')).body.text,'synthetic query');
 await run('click',{tabId:'form',ref:'e2'});await run('scroll',{tabId:'form',direction:'down'});await assert.rejects(run('press',{tabId:'form',key:'Enter'}),/snapshot/);
 await run('snapshot',{tabId:'form'});await assert.rejects(run('press',{tabId:'form',key:'Control+L'}),/supported/);await assert.rejects(run('click',{tabId:'form',ref:'e2'},{...exec,agent:{id:'other'}}),/created by/);
 }finally{off();}
});

test('screenshots use native image attachments rather than a base64 string',async()=>{
 const tools=new Map(),png=Buffer.from([137,80,78,71,13,10,26,10]),saved=[];const off=installCamofoxTools({register(t){tools.set(t.name,t);return()=>{}}},{request:async()=>({tabId:'image-tab'}),screenshot:async()=>png},{saveImage:async a=>{saved.push(a);return {id:'image-proof',mediaType:'image/png'};}}),exec={agent:{id:'qa-image'},signal:AbortSignal.timeout(5000)};
 try{await tools.get('camofox_open').execute({url:'https://example.org'},exec);const tool=tools.get('camofox_screenshot'),value=await tool.execute({tabId:'image-tab'},exec),cloned=structuredClone(value),blocks=tool.finalizeContent(exec,{value:cloned,content:tool.output.render({},cloned),isError:false});assert.equal(saved[0].data,png);assert.equal(blocks[1].type,'image');assert.equal(blocks[1].attachment.id,'image-proof');assert.equal(JSON.stringify(value).includes('base64'),false);const changed=await tool.execute({tabId:'image-tab'},exec);assert.equal(tool.finalizeContent(exec,{value:changed,content:[{type:'text',text:'Policy-filtered result'}],isError:false}),undefined,'Finalization must not bypass a filtered result');}finally{off();}
});

test('browser restart races retry only a refused read/open, never an uncertain form action',async()=>{
 const attempts=new Map();let health=0;
 const runtime=new CamofoxRuntime({},new AbortController().signal,async(url,options)=>{
  if(url.endsWith('/health')){health++;return new Response(JSON.stringify({ok:true,engine:'camoufox'}));}
  const key=options.method+new URL(url).pathname,n=(attempts.get(key)??0)+1;attempts.set(key,n);
  if(n===1)throw Object.assign(new TypeError('fetch failed'),{cause:{code:key.endsWith('/uncertain')?'UND_ERR_SOCKET':'ECONNREFUSED'}});
  return new Response(JSON.stringify({ok:true}));
 });const signal=AbortSignal.timeout(5000);
 assert.deepEqual(await runtime.request('/tabs','POST',{url:'https://example.org'},signal),{ok:true});
 assert.deepEqual(await runtime.request('/tabs/one/snapshot','GET',undefined,signal),{ok:true});
 await assert.rejects(runtime.request('/tabs/one/click','POST',{ref:'e1'},signal),/Check whether the previous action happened/);
 await assert.rejects(runtime.request('/uncertain','GET',undefined,signal),/connection was interrupted/);
 assert.equal(attempts.get('POST/tabs'),2);assert.equal(attempts.get('GET/tabs/one/snapshot'),2);assert.equal(attempts.get('POST/tabs/one/click'),1);assert.equal(attempts.get('GET/uncertain'),1);assert.ok(health>=6);
});
