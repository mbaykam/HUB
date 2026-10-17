import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {join,dirname,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {applyHarnessRuntimePatches,resolveHarnessRuntimePatches,verifyHarnessRuntimePatchesApplied} from '../scripts/harness/runtime-patches.mjs';

test('staged native mobile Recents merge all default and loose chats with one overflow account and preserve project ownership',async t=>{
  const root=await mkdtemp(join(tmpdir(),'hub-recents-'));t.after(()=>rm(root,{recursive:true,force:true}));
  const target=join(root,'node_modules/@deepseek-ai/dsh-client-ui-workspace/lib/client.js');await mkdir(dirname(target),{recursive:true});await writeFile(target,await readFile('vendor/deepseek-harness/packages/client/ui-workspace/lib/client.js'));
  const patches=await resolveHarnessRuntimePatches(resolve('.'),['patches/deepseek-harness/client-navigation-visibility.patch','patches/deepseek-harness/mobile-unified-recents.patch']);await applyHarnessRuntimePatches(root,patches);await verifyHarnessRuntimePatchesApplied(root,patches);
  const code=await readFile(target,'utf8'),nativeStart=code.indexOf('function workspaceTitleOf('),nativeEnd=code.indexOf('\n\t\t/**',code.indexOf('function deriveFlat(')),{deriveFlat,deriveGroups}=new Function(code.slice(nativeStart,nativeEnd)+'; return {deriveFlat,deriveGroups};')(),start=code.indexOf('function hubRecentGroups('),end=code.indexOf('\n\t\tfunction useHubMobileRecents',start),project=new Function('deriveFlat',`return (${code.slice(start,end)});`)(deriveFlat);
  const byId=Object.fromEntries(Array.from({length:30},(_,i)=>['chat-'+i,{id:'chat-'+i,displayTitle:'Chat '+i,updatedAt:1000+i,blank:false,running:i===22,completed:i===21}]));
  Object.assign(byId,{'hidden-archived':{id:'hidden-archived',updatedAt:99999},'hidden-voice':{id:'hidden-voice',updatedAt:99998},'hidden-child':{id:'hidden-child',origin:'subagent',updatedAt:99997},'hidden-blank':{id:'hidden-blank',blank:true,updatedAt:99996}});
  const list={ids:Object.keys(byId),byId,current:'chat-22'},workspaces=[{workspaceId:'home',title:'HUB',path:'C:/home',createdAt:new Date().toISOString(),sessionIds:[...Array.from({length:12},(_,i)=>'chat-'+i),'hidden-archived','hidden-voice']},{workspaceId:'project',title:'Website redesign',path:'C:/project',createdAt:new Date().toISOString(),sessionIds:['chat-28','chat-29']}],hidden=['hidden-archived','hidden-voice'],pending=new Map([['chat-20',{kind:'question'}]]),view={expandedGroups:['home','project','']};
  const before=JSON.stringify({list,workspaces}),native=deriveGroups(list,workspaces,hidden,pending,view),merged=project(native,list,workspaces,hidden,pending,true);
  assert.equal(merged.length,2);assert.equal(merged[0].hubRecents,true);assert.equal(merged[0].sessionCount,28);assert.deepEqual(merged[0].sessions.map(s=>s.id),Array.from({length:28},(_,i)=>'chat-'+(27-i)));
  assert.equal(merged[0].containsCurrent,true);assert.equal(merged[0].sessions.find(s=>s.id==='chat-22').running,true);assert.equal(merged[0].sessions.find(s=>s.id==='chat-20').pendingInteraction,'question');assert.strictEqual(merged[1],native[1]);
  assert.strictEqual(project(native,list,workspaces,hidden,pending,false),native);assert.equal(JSON.stringify({list,workspaces}),before);
  const noDefault=deriveGroups(list,workspaces.slice(1),hidden,pending,view),loose=project(noDefault,list,workspaces.slice(1),hidden,pending,true);assert.equal(loose[0].key,'');assert.equal(loose[1].label,'Website redesign');
});
