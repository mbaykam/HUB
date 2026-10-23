import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {conversationArtifacts,archiveGeneratedArtifacts,artifactDocument,savedAppDocument} from '../packages/harness-overlay/src/host/conversation-artifacts.ts';
import {installDailyUseWeb} from '../packages/harness-overlay/src/host/daily-use-web.ts';
import {KnowledgeStore,digest} from '../packages/harness-overlay/src/host/knowledge-store.ts';
import {withKnowledgeAssetExcerpts} from '../packages/harness-overlay/src/host/knowledge-assets.ts';
import {nativeConversation} from '../packages/harness-overlay/src/host/knowledge-archive.ts';
import {projectMobileActivity} from '../packages/harness-overlay/src/client/host/mobile-activity.ts';
const at=Date.now();
test('saved HTML previews are bounded, keep originals intact, reject non-HTML and invalid UTF-8',()=>{
 const bytes=Buffer.from('<!doctype html><button>Run</button><script>document.title="Ready"</script>'),before=Buffer.from(bytes);
 const app=savedAppDocument({bytes,name:'snake.html',mediaType:'text/html'});assert.equal(app.name,'snake.html');assert.match(app.document,/script-src 'unsafe-inline'/);assert.match(app.document,/connect-src 'none'/);assert.deepEqual(bytes,before);
 for(const file of [{bytes,name:'private.txt',mediaType:'text/plain'},{bytes,name:'game.html',mediaType:'application/octet-stream'},{bytes:Buffer.from([0xff]),name:'bad.html',mediaType:'text/html'},{bytes:Buffer.alloc(3_000_001),name:'large.html',mediaType:'text/html'}])assert.throws(()=>savedAppDocument(file));
});
const events=[{type:'turn/start',seq:1,time:at,data:{turn:1}},{type:'user/message',seq:2,time:at,data:{source:{kind:'user'},content:[{type:'text',text:'Create a calculator for my browser.'}]}},
 {type:'tool/call',seq:3,time:at+1,data:{turn:1,name:'write',callId:'write-1',arguments:JSON.stringify({file_path:'C:\\fixture\\calculator.html',content:'<!doctype html><title>Calculator</title><link rel="stylesheet" href="app.css"><button>7</button><script>document.title="Ready"</script>'})}},
 {type:'tool/result',seq:4,time:at+2,data:{message:{content:[{type:'tool-result',toolCallId:'write-1',isError:false}]}}},
 {type:'assistant/message',seq:5,time:at+3,data:{message:{content:[{type:'text',text:'The calculator is ready.'}]}}},{type:'turn/end',seq:6,time:at+4,data:{turn:1,reason:{kind:'completed'}}}];
test('only successful writes create durable app snapshots, preserving paths and exact bytes',()=>{
 assert.equal(conversationArtifacts(events.slice(0,3)).length,0);
 const failed=structuredClone(events);failed[3].data.message.content[0].isError=true;assert.equal(conversationArtifacts(failed).length,0);
 const [file]=conversationArtifacts(events);assert.equal(file.name,'calculator.html');assert.equal(file.path,'C:/fixture/calculator.html');assert.equal(file.at,at+2);
 const css={...file,path:'C:/fixture/app.css',name:'app.css',content:'button{color:green}'};const html=artifactDocument(file,[file,css]);assert.match(html,/^<!doctype html>/i);assert.match(html,/data:text\/css;base64/);assert.match(html,/connect-src 'none'/);assert.match(html,/form-action 'none'/);assert.match(html,/hubArtifactKey/);assert.equal(file.content,JSON.parse(events[2].data.arguments).content);
});
test('native app originals, excerpts, conversation provenance and domain/subdomain survive a fresh store',async()=>{
 const root=await mkdtemp(join(tmpdir(),'hub-eval-artifact-knowledge-')),store=new KnowledgeStore(join(root,'vault'),join(root,'state'));
 try{await store.initialize();const header={id:'real-fixture-conversation'},record=nativeConversation(header,events,'pwa'),[{artifact,asset}]=await archiveGeneratedArtifacts(header.id,events,store.assets);record.messages.at(-1).assets=[asset];await store.archive.put(record);
 const source=await withKnowledgeAssetExcerpts({id:'explicit-artifact-save',conversationId:record.id,channel:'pwa',completedAt:at+10,content:'The user requested the browser calculator; its successful native write is preserved.',assets:[asset]},store.assets);
 assert.match(source.assetExcerpts[0].text,/<title>Calculator/);assert.equal(asset.createdIn.callId,'write-1');assert.equal(asset.createdIn.path,artifact.path);
 await store.apply({decision:'update-knowledge',reason:'User explicitly requested keeping the created app and its source.',changes:[{id:'browser-calculator',title:'Browser calculator',body:'A calculator created for use in the browser.',expectedHash:null,links:[],media:[{id:asset.id,caption:'Original calculator app'}]}]},source);
 await store.organization.changeDomains(0,[{type:'create',ref:'new-projects',title:'Projects'},{type:'create',ref:'new-browser',title:'Browser apps',parentId:'new-projects'},{type:'assign',nodeId:'browser-calculator',domainId:'new-browser'}]);
 const fresh=new KnowledgeStore(store.vault,store.root),graph=await fresh.graph(),note=await fresh.note('browser-calculator');assert.equal(graph.domains.length,2);assert.equal(graph.memberships.length,1);assert.equal(graph.domains.find(d=>d.id===graph.memberships[0].domainId).parentId,graph.domains.find(d=>d.title==='Projects').id);
 assert.equal(note.sources[0].conversationId,record.id);assert.ok((await fresh.search('calculator',5)).some(n=>n.id==='browser-calculator'));assert.equal((await fresh.archive.read(record.id)).messages.at(-1).assets[0].createdIn.sessionId,header.id);
 assert.equal(digest(await readFile(join(store.vault,asset.path))),asset.id);assert.equal((await fresh.archive.read(record.id)).messages[0].text,'Create a calculator for my browser.');
 }finally{assert.ok(root.startsWith(join(tmpdir(),'hub-eval-artifact-knowledge-')));await rm(root,{recursive:true,force:true});}
});
test('new PWA activity is reconstructed from host state without opening/replaying a task; reads are authenticated',async()=>{
 const routes=new Map();let opened=0,disposed=0,completed=false;
 const ctx={connection:{requestRejection:r=>r.headers.authorization==='fixture'?undefined:401},sessionController:{async list(){return{items:[{sessionId:'parent',running:false,updatedAt:at,projections:{values:{title:'Apps',sessionStats:{toolMs:1}}}},{sessionId:'child',origin:'subagent',running:!completed,updatedAt:at+1,projections:{values:{title:'Calculator',sessionStats:{toolMs:1}}}},{sessionId:'hub-eval-synthetic',running:true}]};}},sessionQuery:{async listSessions(){return[{header:{id:'child',parentSession:'parent'}}]},async observeSession(){opened++;return{events,[Symbol.dispose](){disposed++;}}}},webServer:{register(r){routes.set(r.path,r);return()=>routes.delete(r.path);}}};const off=installDailyUseWeb(ctx);
 async function get(path,headers={authorization:'fixture','x-hub-daily-use':'1'}){let code,value;await routes.get(path).handler({method:'GET',headers},{writeHead(c){code=c},end(s){value=JSON.parse(s)}});return{code,value};}
 try{assert.equal((await get('/api/hub/activity',{})).code,401);const snapshot=(await get('/api/hub/activity')).value;assert.equal(opened,1,'only a read-only end receipt, no agent resumption');const items=projectMobileActivity(snapshot);assert.equal(items.length,1);assert.equal(items[0].status,'running');assert.equal(items[0].sessionId,'child');assert.equal(items[0].title,'Apps');assert.equal(snapshot.byId['hub-eval-synthetic'],undefined);
 completed=true;const ended=(await get('/api/hub/activity')).value;assert.equal(ended.byId.child.parentId,'parent','a child that finishes while the PWA is closed retains its durable parent address');assert.equal(projectMobileActivity(ended).length,1);assert.equal(projectMobileActivity(ended)[0].status,'finished');
 const headers={authorization:'fixture','x-hub-daily-use':'1','x-hub-session':'fixture-session'};const apps=(await get('/api/hub/artifacts',headers)).value;assert.equal(apps.artifacts.length,1);assert.equal(apps.artifacts[0].content,undefined);const app=await get('/api/hub/artifacts',{...headers,'x-hub-artifact':apps.artifacts[0].id});assert.equal(app.code,200);assert.match(app.value.document,/Calculator/);assert.equal(disposed,opened);
 assert.equal((await get('/api/hub/artifacts',{...headers,'x-hub-artifact':'missing'})).code,404);
 }finally{off();assert.equal(routes.size,0);}
});
