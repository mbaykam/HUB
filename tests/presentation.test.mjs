import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { parsePresentation, parsePresentationSummary } from "@minke/harness-overlay/presentation-contract.ts";
import { PresentationRuntime, presentationDocument } from "@minke/harness-overlay/host/presentation.ts";
import { staticPresentation, interactivePresentation, interactivePlanPresentation } from "../scripts/voice/presentation-fixtures.mjs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { createPresentationHandler } from "@minke/harness-overlay/host/presentation-web.ts";
import { createServer } from "node:http";

test("visual contracts bound content and prevent external, prototype and explosive data inputs", () => {
  assert.deepEqual(parsePresentation(staticPresentation), staticPresentation);
  const parsed = parsePresentation(interactivePresentation); assert.deepEqual(parsed, interactivePresentation); assert.notEqual(parsed.spec, interactivePresentation.spec);
  for (const input of [
    { ...staticPresentation, title: "" }, { ...staticPresentation, html: "x".repeat(128001) },
    { title: "Bad", kind: "js", code: "alert(1)" },
    { ...interactivePresentation, spec: { width: Infinity } },
    { ...interactivePresentation, spec: { data: [{ url: "https://example.com" }] } },
    { ...interactivePresentation, spec: { data: [{ values: Array(5001).fill(0) }] } },
    { ...interactivePresentation, spec: { data: [{ transform: [{ type: "sequence", stop: 1e20 }] }] } },
    { ...interactivePresentation, spec: { data: [{ transform: [{ type: "cross" }] }] } },
    { ...interactivePresentation, spec: JSON.parse('{"__proto__":{}}') },
  ]) assert.throws(() => parsePresentation(input));
  assert.throws(() => parsePresentationSummary({ id: "-".repeat(36), title: "Bad", kind: "html", createdAt: 1 }));
});

test("native presentation tool is scoped, abort-safe, replaceable and revoked when voice closes", async () => {
  const runtime = new PresentationRuntime(); let definition, removed = 0;
  const agent = { id: "voice-one", ctx: { tools: { register(value) { definition = value; return () => removed++; } }, systemPrompt: { section() { return () => removed++; } } } };
  const off = runtime.attach(agent);
  assert.match(definition.description,/encode\.update/);
  await assert.rejects(definition.execute(staticPresentation, { agent: { id: "foreign" }, signal: new AbortController().signal }));
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(definition.execute(staticPresentation, { agent, signal: aborted.signal }));
  assert.equal(runtime.summary(agent.id), null);
  const one = await definition.execute(staticPresentation, { agent, signal: new AbortController().signal });
  const two = await definition.execute(interactivePresentation, { agent, signal: new AbortController().signal });
  assert.notEqual(one.id, two.id); assert.equal(two.status, "available");
  assert.throws(() => runtime.document(agent.id, one.id, ""));
  assert.equal(runtime.summary("foreign"), null);
  off(); off(); assert.equal(removed, 2); assert.equal(runtime.summary(agent.id), null);
  await assert.rejects(definition.execute(staticPresentation, { agent, signal: new AbortController().signal }));
});

test("interpreted Vega updates existing bar geometry and labels when a local signal changes",async()=>{
  const require=createRequire(new URL('../packages/harness-overlay/package.json',import.meta.url));
  const {View,parse}=await import(pathToFileURL(require.resolve('vega')).href);
  const {expressionInterpreter}=await import(pathToFileURL(require.resolve('vega-interpreter')).href);
  const input=parsePresentation(interactivePlanPresentation),view=new View(parse(input.spec,undefined,{ast:true}),{expr:expressionInterpreter,renderer:'none'});
  try{
    await view.runAsync();const initial=await view.toSVG();assert.match(initial,/10 min/);
    const bars=()=>view.scenegraph().root.items[0].items.find(mark=>mark.marktype==='rect').items;
    const firstHeight=bars().find(item=>item.datum.task==='Break').height,readingHeight=bars().find(item=>item.datum.task==='Reading').height;
    await view.signal('breakMinutes',12).runAsync();assert.equal(view.data('plan')[2].displayMinutes,12);
    const updated=await view.toSVG();assert.match(updated,/12 min/);assert.doesNotMatch(updated,/>10 min</);assert.notEqual(initial,updated);
    assert.ok(bars().find(item=>item.datum.task==='Break').height>firstHeight,'The existing bar must resize, not just its label');assert.equal(bars().find(item=>item.datum.task==='Reading').height,readingHeight);
  }finally{view.finalize();}
});

test("failed tool/prompt installation can retry without leaving a phantom presentation owner", () => {
  const runtime = new PresentationRuntime(); let fail = true, removed = 0;
  const agent = { id: "voice-one", ctx: { tools: { register() { return () => removed++; } }, systemPrompt: { section() { if (fail) throw new Error("Fixture failure"); return () => {}; } } } };
  assert.throws(() => runtime.attach(agent)); assert.equal(removed, 1);
  fail = false; runtime.attach(agent)(); assert.equal(removed, 2);
});

test("visual document hashes only the fixed renderer and escapes model text out of HTML syntax", () => {
  const item = { ...staticPresentation, id: randomUUID(), createdAt: Date.now(), html: '</script><script>parent.location="https://example.com"</script>' };
  const doc = presentationDocument(item, "document.body.dataset.fixture='ready';");
  assert.match(doc, /script-src 'sha256-/); assert.match(doc, /connect-src 'none'/); assert.match(doc, /worker-src 'none'/);
  assert.doesNotMatch(doc, /unsafe-eval/); assert.doesNotMatch(doc, /<script>parent/); assert.match(doc, /\\u003c\/script/);
  assert.throws(() => presentationDocument(item, "'</script>'"));
});

test("text and voice share one scoped tool without revoking the surviving conversation owner", async () => {
  const runtime = new PresentationRuntime(); let tool, registrations = 0, removals = 0;
  const agent = { id: "chat-one", ctx: { tools: { register(value) { registrations++; tool = value; return () => removals++; } }, systemPrompt: { section() { return () => {}; } } } };
  const text = runtime.attach(agent), voice = runtime.attach(agent);
  assert.equal(registrations, 1);
  const result = await tool.execute(staticPresentation, { agent, signal: new AbortController().signal });
  voice(); voice(); assert.equal(removals, 0); assert.equal(runtime.summary(agent.id).id, result.id);
  text(); assert.equal(removals, 1); assert.equal(runtime.summary(agent.id), null);
});

test("conversation visual HTTP access requires authentication and exact session/document ownership", async () => {
  const runtime = new PresentationRuntime(); let tool;
  const agent = { id: "hub-eval-canvas", ctx: { tools: { register(value) { tool = value; return () => {}; } }, systemPrompt: { section() { return () => {}; } } } };
  const off = runtime.attach(agent);
  const result = await tool.execute(staticPresentation, { agent, signal: new AbortController().signal });
  const server = createServer(createPresentationHandler(runtime, req => req.headers.cookie === "fixture=1" ? undefined : 401, async () => "document.body.dataset.ready='yes';"));
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/api/hub/`;
  const headers = { cookie: "fixture=1", "x-hub-session": agent.id, "x-hub-presentation": result.id };
  try {
    assert.equal((await fetch(url + "presentation")).status, 401);
    assert.equal((await fetch(url + "presentation", { headers: { ...headers, "sec-fetch-site": "cross-site" } })).status, 403);
    assert.equal((await fetch(url + "presentation", { method: "POST", headers })).status, 405);
    assert.equal((await fetch(url + "presentation", { headers: { ...headers, "x-hub-session": "../foreign" } })).status, 400);
    assert.equal((await (await fetch(url + "presentation", { headers })).json()).presentation.id, result.id);
    assert.equal((await (await fetch(url + "presentation", { headers: { ...headers, "x-hub-session": "foreign" } })).json()).presentation, null);
    assert.equal((await fetch(url + "presentation-document", { headers: { ...headers, "x-hub-session": "foreign" } })).status, 404);
    assert.match((await (await fetch(url + "presentation-document", { headers })).json()).document, /connect-src 'none'/);
    const updated = await tool.execute(interactivePresentation, { agent, signal: new AbortController().signal });
    assert.notEqual(updated.id, result.id);
    assert.equal((await fetch(url + "presentation-document", { headers })).status, 404);
  } finally { off(); await new Promise(resolve => server.close(resolve)); }
});

// A scripted utility is intentionally broader than a game or chart preset.
test('app payload supports local utilities without game-specific controls or a host bridge', async()=>{
 const {JSDOM}=await import('../vendor/deepseek-harness/node_modules/jsdom/lib/api.js');
 const {recordedPresentation}=await import('@minke/harness-overlay/host/presentation.ts');
 const payload={title:'Unit converter',kind:'app',html:`<!doctype html><html><head><style>body{color:white;background:#111}</style></head><body><label>Centimetres <input id="cm" type="number" value="10"></label><output id="out"></output><script>const cm=document.getElementById('cm'),out=document.getElementById('out');function update(){out.textContent=(Number(cm.value)/2.54).toFixed(2)+' inches'}cm.addEventListener('input',update);update();</script></body></html>`};
 assert.deepEqual(parsePresentation(payload),payload);
 const id=randomUUID(),document=presentationDocument({...payload,id,createdAt:1},'');
 const outer=new JSDOM(document),frame=outer.window.document.querySelector('iframe');
 assert.equal(outer.window.document.querySelectorAll('button,script').length,0);
 assert.equal(frame.getAttribute('sandbox'),'allow-scripts');assert.match(frame.srcdoc,/connect-src 'none'/);assert.doesNotMatch(document,/Game controls|hubArtifactKey|allow-same-origin/);
 // DOM execution is a simulation; browser sandbox enforcement is a separate acceptance check.
 const app=new JSDOM(frame.srcdoc,{runScripts:'dangerously'});
 try{const input=app.window.document.getElementById('cm');assert.equal(app.window.document.getElementById('out').textContent,'3.94 inches');input.value='25.4';input.dispatchEvent(new app.window.Event('input'));assert.equal(app.window.document.getElementById('out').textContent,'10.00 inches');}finally{app.window.close();outer.window.close();}
 const call={type:'tool/call',data:{callId:'app-call',name:'hub_present',arguments:JSON.stringify(payload)}};
 const receipt={type:'tool/result',time:123,data:{message:{content:[{type:'tool-result',toolCallId:'app-call',isError:false,content:[{type:'text',text:JSON.stringify({id,title:payload.title,status:'available'})}]}]}}};
 const recorded=recordedPresentation([call,receipt]);assert.equal(recorded.id,id);assert.equal(recorded.html,payload.html);
 assert.equal(recordedPresentation([call]),undefined);assert.equal(recordedPresentation([receipt]),undefined);
 assert.equal(recordedPresentation([call,{...receipt,data:{message:{content:[{...receipt.data.message.content[0],isError:true}]}}}]),undefined);
 const cold=new PresentationRuntime();cold.recover('saved-chat',[call,receipt]);assert.equal(cold.summary('saved-chat').id,id);assert.equal(cold.summary('other-chat'),null);assert.match(cold.document('saved-chat',id,''),/Unit converter/);
});

test('cold conversation canvas restores only through authenticated read-only session history',async()=>{
 const runtime=new PresentationRuntime(),id=randomUUID(),payload={title:'Saved explanation',kind:'app',html:'<button>Local</button>'};let reads=0;
 const events=[{type:'tool/call',data:{callId:'one',name:'hub_present',arguments:payload}},{type:'tool/result',time:10,data:{message:{content:[{type:'tool-result',toolCallId:'one',isError:false,content:[{type:'text',text:JSON.stringify({id,title:payload.title,status:'available'})}]}]}}}];
 const handler=createPresentationHandler(runtime,r=>r.headers.cookie==='fixture=1'?undefined:401,async()=>'',async session=>{reads++;assert.equal(session,'saved-chat');return events;});
 const server=createServer(handler);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/api/hub/`;
 try{assert.equal((await fetch(base+'presentation',{headers:{'x-hub-session':'saved-chat'}})).status,401);assert.equal(reads,0);const headers={cookie:'fixture=1','x-hub-session':'saved-chat','x-hub-presentation':id};assert.equal((await(await fetch(base+'presentation',{headers})).json()).presentation.id,id);assert.match((await(await fetch(base+'presentation-document',{headers})).json()).document,/Local/);assert.equal(reads,1);}finally{await new Promise(r=>server.close(r));}
});
