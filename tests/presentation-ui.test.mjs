import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { JSDOM } from "../vendor/deepseek-harness/node_modules/jsdom/lib/api.js";
import { createMobilePresentation, installConversationPresentation } from "@minke/harness-overlay/client/host/mobile-presentation.ts";

const tick = (ms = 30) => new Promise(resolve => setTimeout(resolve, ms));
test("canvas follows updates, can freeze/reopen, and cannot carry a visual into another chat", async () => {
  const dom = new JSDOM("<body></body>", { url: "http://localhost/", pretendToBeVisual: true });
  const { window } = dom, doc = window.document, priorEvent = globalThis.Event;
  globalThis.Event = window.Event;
  window.HTMLDialogElement.prototype.show = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new window.Event("close")); };
  let latest = { id: randomUUID(), title: "First plan", kind: "html", createdAt: 1 };
  const requests = [];
  window.fetch = async (url, init) => { requests.push({ url, headers: init.headers }); return Response.json(url.endsWith("presentation-document") ? { document: "<p>Fixture visual</p>" } : { presentation: init.headers["x-hub-session"] === "other" ? null : latest }); };
  const canvas = createMobilePresentation(doc); doc.body.append(canvas.button);
  try {
    canvas.setSession("hub-eval-canvas"); await tick();
    assert.equal(canvas.dialog.open, true); assert.equal(canvas.dialog.hasAttribute("data-expanded"),false); assert.equal(canvas.dialog.querySelector("iframe").title, "First plan");
    const originalFrame=canvas.dialog.querySelector("iframe");
    [...canvas.dialog.querySelectorAll("button")].find(b=>b.textContent==="Expand").click();
    assert.equal(canvas.dialog.hasAttribute("data-expanded"),true);assert.equal(canvas.dialog.querySelector("iframe"),originalFrame);
    [...canvas.dialog.querySelectorAll("button")].find(b=>b.textContent==="Back to chat").click();
    assert.equal(canvas.dialog.hasAttribute("data-expanded"),false);assert.equal(canvas.dialog.querySelector("iframe"),originalFrame);
    assert.equal(canvas.dialog.querySelector("iframe").getAttribute("sandbox"), "allow-scripts");
    latest = { ...latest, id: randomUUID(), title: "Updated plan" }; await tick(1600);
    assert.equal(canvas.dialog.querySelector("iframe").title, "Updated plan");
    canvas.dialog.querySelector('[aria-pressed]').click();
    latest = { ...latest, id: randomUUID(), title: "Frozen update" }; await tick(1600);
    assert.equal(canvas.dialog.querySelector("iframe").title, "Updated plan");
    const update = [...canvas.dialog.querySelectorAll("button")].find(button => button.textContent === "Show latest");
    assert.equal(update.hidden, false); update.click(); await tick();
    assert.equal(canvas.dialog.querySelector("iframe").title, "Frozen update");
    canvas.dialog.close(); await tick(1600); assert.equal(canvas.dialog.open, false);
    canvas.button.click(); await tick(); assert.equal(canvas.dialog.open, true);
    canvas.setSession("other"); await tick(); assert.equal(canvas.dialog.open, false); assert.equal(canvas.button.hidden, true);
    canvas.setSession("hub-eval-canvas"); await tick(); assert.equal(canvas.dialog.open, false); assert.equal(canvas.button.hidden, false);
    canvas.setCall("call-fixture"); await tick(); assert.ok(requests.some(request => request.url.includes("/voice/") && request.headers["x-hub-voice-call"] === "call-fixture"));
    canvas.setCall(undefined); await tick(); assert.equal(canvas.dialog.open, false);
  } finally { canvas.dispose(); dom.window.close(); globalThis.Event = priorEvent; }
});

test("visual launcher follows native header replacement and voice Home without covering the composer",async()=>{
 const dom=new JSDOM('<header data-slot="conversation.session.header.utilities"></header><main data-conversation-scroll><div data-composer-seat></div><section data-hub-voice-hub></section></main>',{url:'http://localhost',pretendToBeVisual:true});
 const {window}=dom,doc=window.document,priorEvent=globalThis.Event;globalThis.Event=window.Event;
 window.HTMLDialogElement.prototype.close=function(){this.removeAttribute('open');this.dispatchEvent(new window.Event('close'));};
 window.fetch=async()=>Response.json({presentation:null});
 let current='hub-eval-canvas',changed;
 const dispose=installConversationPresentation({sessions:{list:{getSnapshot:()=>({current}),subscribe:fn=>{changed=fn;return()=>{};}}}},doc);
 try{
  await tick(50);const button=doc.querySelector('[data-hub-chat-visual]'),header=doc.querySelector('header');assert.equal(button.parentElement,header);assert.equal(window.getComputedStyle(button).position,'static');assert.equal(doc.querySelector('[data-composer-seat]').contains(button),false);assert.equal(doc.querySelector('[data-conversation-scroll]').firstElementChild,doc.querySelector('dialog'));
  const replacement=doc.createElement('header');replacement.setAttribute('data-slot','conversation.session.header.utilities');header.replaceWith(replacement);await tick(50);assert.equal(button.parentElement,replacement);
  current=undefined;changed();doc.dispatchEvent(new window.CustomEvent('hub:presentation-call',{detail:{callId:'fixture-call'}}));await tick(50);assert.equal(button.parentElement,doc.querySelector('[data-hub-voice-hub]'));
  current='hub-eval-canvas';changed();await tick(50);assert.equal(button.parentElement,replacement);
 }finally{dispose();dom.window.close();globalThis.Event=priorEvent;}
});

test('queued native close events preserve expansion, frame state and the composer focus',async()=>{
 const dom=new JSDOM('<textarea aria-label="Message"></textarea>',{url:'http://localhost',pretendToBeVisual:true}),w=dom.window,doc=w.document,prior=globalThis.Event;globalThis.Event=w.Event;
 w.HTMLDialogElement.prototype.show=function(){this.open=true;this.querySelector("button")?.focus();};w.HTMLDialogElement.prototype.showModal=function(){this.open=true;};w.HTMLDialogElement.prototype.close=function(){if(!this.open)return;this.open=false;setTimeout(()=>this.dispatchEvent(new w.Event('close')),0);};
 let finish;const item={id:randomUUID(),title:'Interactive lesson',kind:'app',createdAt:1};w.fetch=async url=>url.endsWith('presentation-document')?new Promise(r=>finish=r):Response.json({presentation:item});
 const canvas=createMobilePresentation(doc);doc.body.append(canvas.button);doc.querySelector('textarea').focus();
 try{canvas.setSession('hub-eval-canvas');await tick();assert.equal(doc.activeElement,doc.querySelector('textarea'));finish(Response.json({document:'<input value="local">'}));await tick();const iframe=canvas.dialog.querySelector('iframe');
  [...canvas.dialog.querySelectorAll('button')].find(b=>b.textContent==='Expand').click();await tick();assert.equal(canvas.dialog.hasAttribute('data-expanded'),true);assert.equal(canvas.dialog.querySelector('iframe'),iframe);
  [...canvas.dialog.querySelectorAll('button')].find(b=>b.textContent==='Back to chat').click();await tick();assert.equal(canvas.dialog.hasAttribute('data-expanded'),false);assert.equal(canvas.dialog.querySelector('iframe'),iframe);
  [...canvas.dialog.querySelectorAll('button')].find(b=>b.textContent==='Hide').click();await tick();assert.equal(canvas.dialog.open,false);assert.equal(canvas.dialog.querySelector('iframe'),null);
 }finally{canvas.dispose();dom.window.close();globalThis.Event=prior;}
});
