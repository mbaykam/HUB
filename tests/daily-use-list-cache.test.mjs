import test from 'node:test';
import assert from 'node:assert/strict';
import {installDailyUseWeb} from '../packages/harness-overlay/src/host/daily-use-web.ts';

test('the chat list is listed once while nothing changes, and again after any chat event',async()=>{
 let listed=0,title='First';const routes=new Map(),handlers=[];
 const ctx={connection:{requestRejection:r=>r.headers.authorization==='fixture'?undefined:401},
  sessionController:{async list(){listed++;return{items:[{sessionId:'chat-1',running:false,updatedAt:1,projections:{values:{title}}}]};}},
  on(name,handler){assert.equal(name,'session/event');handlers.push(handler);return()=>handlers.splice(handlers.indexOf(handler),1);},
  webServer:{register(r){routes.set(r.path,r);return()=>routes.delete(r.path);}}};
 const off=installDailyUseWeb(ctx);
 const get=async path=>{let value;await routes.get(path).handler({method:'GET',headers:{authorization:'fixture','x-hub-daily-use':'1'}},{writeHead(){},end(s){value=JSON.parse(s);}});return value;};
 try{
  assert.equal((await get('/api/hub/conversations')).conversations[0].title,'First');
  await get('/api/hub/conversations');await get('/api/hub/conversations');
  assert.equal(listed,1,'nothing changed, so the finished listing is reused');
  title='Renamed';handlers.forEach(h=>h({header:{id:'chat-1'}},{type:'session/title'}));
  assert.equal((await get('/api/hub/conversations')).conversations[0].title,'Renamed');
  assert.equal(listed,2);
 }finally{off();}
 assert.equal(handlers.length,0,'the event subscription ends with the routes');
});
