import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "../vendor/deepseek-harness/node_modules/jsdom/lib/api.js";
import { projectMobileActivity, createMobileActivity, createActivitySignals } from "@minke/harness-overlay/client/host/mobile-activity.ts";

test("Home activity uses native session and job facts without duplicating visible jobs or inventing success", () => {
  const job = { id: "shared-job", kind: "bash", label: "Build", detail: "Compiler output", status: "running", startedAt: 15 };
  const items = projectMobileActivity({ phase: "ready", byId: {
    voice: { running: true, title: "Voice coordinator" }, child: { origin: "subagent", running: true, title: "Research", updatedAt: 22 },
    finished: { completed: true, title: "Recently finished", updatedAt: 23 }, idle: { title: "Old chat" },
  }, jobsBySession: { voice: [job], child: [job, { ...job, id: "old", status: "completed", finishedAt: 1 }] } }, "voice", 1_000_000);
  assert.deepEqual(items.map(item => item.id), ["session:child", "session:finished"]);
  assert.equal(items[0].steps.length, 1, "The shared background process appears once inside its work");
  assert.equal(items.at(-1).status, "finished");
  assert.equal(projectMobileActivity({ byId: { child: { running: true } } }).length, 1);
});

test("activity renderer updates live, opens the native context once and renders untrusted labels as text", () => {
  const dom = new JSDOM(); const opened = [];
  const { panel, update } = createMobileActivity(dom.window.document, id => opened.push(id));
  update({ byId: {}, phase: "pending" });
  assert.match(panel.textContent, /Connecting/);
  const byId = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [String(i), { title: "<img src=x> " + i, running: true }]));
  update({ byId, phase: "ready" });
  assert.equal(panel.querySelectorAll("[data-hub-work]").length, 4);
  assert.equal(panel.querySelectorAll("[data-hub-work-grid] > [data-hub-work]").length, 4);
  assert.equal(panel.querySelector("img"), null);
  panel.lastElementChild.click(); assert.equal(panel.querySelectorAll("[data-hub-work]").length, 6);
  panel.querySelector("[data-hub-work-open]").click(); assert.deepEqual(opened, ["0"]);
  update({ byId: {}, phase: "ready" }); assert.match(panel.textContent, /Nothing running/);
  update({ byId, phase: "ready" }, undefined, "disconnected"); assert.match(panel.textContent, /Status is unavailable/);
  assert.equal(panel.querySelector('[data-work-status="running"]'), null);
  update({ byId, phase: "ready" }, undefined, "connected"); assert.doesNotMatch(panel.textContent, /Status is unavailable/);
  dom.window.close();
});

test("a finished coordinator with a running descendant is one active work, opening the running child", () => {
  const items = projectMobileActivity({byId:{parent:{title:'Inspect the website',completed:true,running:false},child:{title:'Read sources',origin:'subagent',parentId:'parent',running:true,updatedAt:20},grandchild:{title:'Compare',origin:'subagent',parentId:'child',running:true,updatedAt:30}}});
  assert.equal(items.length,1);assert.equal(items[0].status,'running');assert.equal(items[0].title,'Inspect the website');assert.equal(items[0].sessionId,'grandchild');assert.equal(items[0].activeAssistants,2);assert.equal(items[0].steps.length,2);
});
test("a completed process cannot mark a still-running assistant or queued turn completed", () => {
  const snapshot={byId:{chat:{title:'Build the app',running:true,completed:true}},jobsBySession:{chat:[{id:'build',kind:'bash',label:'Compile',status:'completed',startedAt:10,finishedAt:20}]}};
  const item=projectMobileActivity(snapshot,undefined,30)[0];assert.equal(item.status,'running');assert.equal(item.steps[0].status,'completed');assert.equal(item.activeProcesses,0);
  snapshot.byId.chat.running=false;snapshot.observations={chat:{queued:1}};assert.equal(projectMobileActivity(snapshot,undefined,30)[0].status,'waiting');
});
test("catalog-only live children keep work active, while stale catalog activity cannot override known session status", () => {
  const snapshot={byId:{parent:{completed:true}},subagentsByParent:{parent:{entries:[{kind:'child',id:'child',label:'Research',activity:'running'}]}}};
  assert.equal(projectMobileActivity(snapshot)[0].status,'running');assert.equal(projectMobileActivity(snapshot)[0].sessionId,'child');
  snapshot.byId.child={origin:'subagent',parentId:'parent',running:false};assert.equal(projectMobileActivity(snapshot)[0].status,'finished');
});
test("permission waits, terminal failures, and fresh shared-job receipts retain their native meaning", () => {
  const snapshot={byId:{a:{running:true},b:{running:false,completed:true}},pendingBySession:new Map([['a',{kind:'permission'}]]),observations:{b:{failed:true}}};
  const items=projectMobileActivity(snapshot);assert.equal(items[0].status,'attention');assert.match(items[0].detail,/permission/);assert.equal(items[1].status,'failed');
  const old={id:'shared',kind:'bash',label:'Compile',status:'running',startedAt:10};
  const completed={...old,status:'completed',finishedAt:25};
  const jobs=projectMobileActivity({byId:{a:{},b:{}},jobsBySession:{a:[old],b:[completed]}},undefined,30);assert.equal(jobs.length,1);assert.equal(jobs[0].status,'completed');
});
test("voice descendants stay visible, forks do not inherit task grouping, and internal maintenance does not fill Home", () => {
  const items=projectMobileActivity({byId:{voice:{running:true},child:{origin:'subagent',parentId:'voice',running:true},fork:{parentId:'child',running:true},'hub-memory-reflect':{running:true}}},'voice');
  assert.deepEqual(new Set(items.map(i=>i.id)),new Set(['session:child','session:fork']));
  assert.doesNotThrow(()=>projectMobileActivity({byId:{a:{origin:'subagent',parentId:'b',running:true},b:{origin:'subagent',parentId:'a',running:true}}}));
});
test("reviewing a completed reply does not erase its recent work, and resuming it clears the finished badge", () => {
  const dom=new JSDOM(),renderer=createMobileActivity(dom.window.document,()=>{});
  renderer.update({byId:{task:{running:true,title:'Research'}},phase:'ready'});
  renderer.update({byId:{task:{running:false,completed:true,title:'Research'}},phase:'ready'});assert.equal(renderer.panel.querySelector('[data-work-badge]').textContent,'Reply ready');
  renderer.update({byId:{task:{running:false,title:'Research'}},phase:'ready'});assert.ok(renderer.panel.querySelector('[data-hub-work]'));
  renderer.update({byId:{task:{running:true,title:'Research'}},phase:'ready'});assert.equal(renderer.panel.querySelector('[data-work-badge]').textContent,'Working');dom.window.close();
});
test("native observable signals expose queue/error flags and observed tool names, never arguments, reasoning, or execution", () => {
  let off=0,opened=0;const listeners=new Set();let value={queue:[{}],lastAgentError:'PRIVATE ERROR DETAILS'};
  const subscribe=cb=>{listeners.add(cb);return()=>{listeners.delete(cb);off++}};
  const binding={session:{getSnapshot:()=>value,subscribe,prompt:()=>{opened++}},eventSource:{subscribe,getSnapshot:()=>({entries:[{type:'event',event:{type:'assistant/reasoning',data:'SECRET REASONING'}},{type:'event',event:{type:'tool/call',data:{call:{name:'web_fetch',arguments:{token:'SECRET TOKEN'}}}}}]})}};
  let current=binding,changed=0;const signals=createActivitySignals({binding:()=>current},()=>changed++);
  const snapshot={byId:{task:{running:true}}};const observed=signals.read(snapshot);assert.equal(observed.task.queued,1);assert.equal(observed.task.failed,true);assert.equal(observed.task.lastAction,'Web research');assert.doesNotMatch(JSON.stringify(observed),/PRIVATE|SECRET/);assert.equal(opened,0);
  for(const cb of listeners)cb();assert.equal(changed,1);current={session:{getSnapshot:()=>({queue:[],lastAgentError:null})}};signals.read(snapshot);assert.equal(off,2);signals.dispose();
});
