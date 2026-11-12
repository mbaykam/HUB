import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { JSDOM } from "../vendor/deepseek-harness/node_modules/jsdom/lib/api.js";
import { createKnowledgeActivity } from "../packages/harness-overlay/src/client/host/mobile-knowledge-activity.ts";

const page={version:1,state:"ready",enabled:true,total:0,offset:0,entries:[],historyNotice:"Old history is not reconstructed."};
test("activity entry handles empty/error/refresh and closes without queuing work",async()=>{
  const dom=new JSDOM("<main></main>",{url:"https://hub.test",pretendToBeVisual:true}),root=dom.window.document;let failed=true,calls=0;
  dom.window.fetch=async(url,options)=>{calls++;assert.equal(url,"/api/hub/memory?view=activity&offset=0");assert.equal(options.method,undefined);assert.equal(options.headers["x-hub-memory"],"1");return {ok:!failed,json:async()=>page};};
  const ui=createKnowledgeActivity(root,()=>{});root.querySelector("main").append(ui.tile);
  try{assert.equal(calls,0);ui.tile.click();await setImmediate();assert.match(ui.dialog.textContent,/could not load/);failed=false;[...ui.dialog.querySelectorAll("button")].find(button=>button.textContent==="Refresh").click();await setImmediate();assert.match(ui.dialog.textContent,/No activity has been recorded/);assert.equal(ui.dialog.querySelector("h2").textContent,"Knowledge AI · Activity");[...ui.dialog.querySelectorAll("button")].find(button=>button.textContent==="Close").click();assert.equal(ui.dialog.open,false);assert.equal(root.activeElement,ui.tile);assert.equal(calls,2);}finally{ui.dispose();dom.window.close();}
});
test("late activity response cannot reopen or update a closed mobile dialog",async()=>{
  const dom=new JSDOM("<main></main>",{url:"https://hub.test",pretendToBeVisual:true});let finish;dom.window.fetch=()=>new Promise(resolve=>{finish=resolve;});const ui=createKnowledgeActivity(dom.window.document,()=>{});dom.window.document.body.append(ui.tile);
  try{ui.tile.click();ui.dialog.querySelector("button").click();finish({ok:true,json:async()=>page});await setImmediate();assert.equal(ui.dialog.open,false);assert.doesNotMatch(ui.dialog.textContent,/No activity has been recorded/);}finally{ui.dispose();dom.window.close();}
});

test("refresh preserves the details being read and the dialog scroll position",async()=>{
  const dom=new JSDOM("<main></main>",{url:"https://hub.test",pretendToBeVisual:true});
  const entry={id:"stable-job",status:"done",outcome:"skipped",updatedAt:1,attempts:1,previousAttempts:[],changes:[],warnings:[],source:{channel:"pwa",assets:[]}};
  dom.window.fetch=async()=>({ok:true,json:async()=>({...page,total:1,entries:[entry]})});
  const ui=createKnowledgeActivity(dom.window.document,()=>{});dom.window.document.body.append(ui.tile);
  try{ui.tile.click();await setImmediate();ui.dialog.querySelector("details").open=true;ui.dialog.scrollTop=150;[...ui.dialog.querySelectorAll("button")].find(b=>b.textContent==="Refresh").click();await setImmediate();assert.equal(ui.dialog.querySelector("details").open,true);assert.equal(ui.dialog.scrollTop,150);}finally{ui.dispose();dom.window.close();}
});
