import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {once} from 'node:events';
import {PhoneContextStore,createPhoneContextHandler,parsePhoneContext,attachPhoneContextTool,describePhoneContext} from '../packages/harness-overlay/src/host/phone-context.ts';

const now=1794900000000;
const reading={capturedAt:now-1000,location:{latitude:41.0082,longitude:28.9784,accuracyMeters:12.4,speedMetersPerSecond:1.23},
  place:{name:'Sultanahmet Square',city:'Istanbul',country:'Türkiye',secret:'dropped'},
  nearby:[{name:'Hagia Sophia',category:'museum',distanceMeters:180.6},{name:''},{category:'x'}],
  device:{batteryPercent:57.4,charging:false,network:'wifi',extra:1},motion:'walking',unknown:true};

test('phone readings keep only bounded documented fields',()=>{
 const s=parsePhoneContext(reading,now);
 assert.deepEqual(s.location,{latitude:41.0082,longitude:28.9784,accuracyMeters:12,speedMetersPerSecond:1.2});
 assert.deepEqual(s.place,{name:'Sultanahmet Square',city:'Istanbul',country:'Türkiye'});
 assert.deepEqual(s.nearby,[{name:'Hagia Sophia',category:'museum',distanceMeters:181}]);
 assert.deepEqual(s.device,{batteryPercent:57,charging:false,network:'wifi'});
 assert.equal(s.motion,'walking');assert.equal('unknown' in s,false);
 for(const bad of [null,[],{},{capturedAt:now+600000},{capturedAt:now,location:{latitude:91,longitude:0,accuracyMeters:1}}])assert.throws(()=>parsePhoneContext(bad,now));
});

test('the endpoint stores a reading only for the authorized app and reports pending requests',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-phone-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let clock=now;const store=new PhoneContextStore(root,()=>clock);
 const handler=createPhoneContextHandler(store,req=>req.headers.cookie==='ok=1'?undefined:401);
 const server=createServer((q,s)=>void handler(q,s));server.listen(0,'127.0.0.1');await once(server,'listening');t.after(()=>server.close());
 const url=`http://127.0.0.1:${server.address().port}/api/hub/phone/context`,headers={cookie:'ok=1','x-hub-phone-context':'1','content-type':'application/json'};
 assert.equal((await fetch(url,{method:'POST',body:'{}'})).status,401);
 assert.equal((await fetch(url,{headers:{cookie:'ok=1'}})).status,403);
 assert.deepEqual(await(await fetch(url,{headers})).json(),{requested:false});
 const waiting=store.requestFresh(2000);
 assert.deepEqual(await(await fetch(url,{headers})).json(),{requested:true});
 const saved=await fetch(url,{method:'POST',headers,body:JSON.stringify(reading)});assert.equal(saved.status,200);
 assert.equal(await waiting,true);
 assert.equal(store.latest().place.city,'Istanbul');
 assert.equal(JSON.parse(await readFile(join(root,'latest.json'),'utf8')).location.latitude,41.0082);
 assert.equal((await fetch(url,{method:'POST',headers,body:JSON.stringify({capturedAt:'x'})})).status,400);
 const reopened=new PhoneContextStore(root,()=>clock);await reopened.load();assert.equal(reopened.latest().motion,'walking');
});

test('the assistant tool asks for a fresh reading and reports its age honestly',async t=>{
 const root=await mkdtemp(join(tmpdir(),'hub-phone-'));t.after(()=>rm(root,{recursive:true,force:true}));
 let clock=now;const store=new PhoneContextStore(root,()=>clock);let tool,section;
 const agent={ctx:{tools:{register(d){tool=d;return()=>{};}},systemPrompt:{section(s){section=s;return()=>{};}}}};
 attachPhoneContextTool(agent,store,()=>true);
 assert.match(section.text,/hub_phone_context/);
 const signal=new AbortController().signal;
 const pending=tool.execute({fresh:true},{signal});
 let write;setTimeout(()=>{write=store.save(parsePhoneContext(reading,clock));},20);
 const value=await pending;await write;
 assert.equal(value.available,true);assert.equal(value.fresh,true);assert.equal(value.ageSeconds,1);assert.equal(value.place.city,'Istanbul');
 assert.equal(describePhoneContext(undefined,now,false).available,false);
 const blocked={ctx:agent.ctx};let blockedTool;blocked.ctx={...agent.ctx,tools:{register(d){blockedTool=d;return()=>{};}}};
 attachPhoneContextTool(blocked,store,()=>false);
 await assert.rejects(blockedTool.execute({},{signal}),/disabled/);
 await assert.rejects(tool.execute({where:'x'},{signal}),/Only the fresh option/);
});
