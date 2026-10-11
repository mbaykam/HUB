import test from "node:test";
import assert from "node:assert/strict";
import { createVoiceConversation } from "@minke/harness-overlay/host/voice-conversation.ts";

function fixture() {
  let listener, running = false, cancelCount = 0, idle = Promise.resolve();
  const prompts = []; const output = [];
  const ports = {
    sessionId: "voice-test", running: () => running,
    subscribe(fn) { listener = fn; return () => { listener = undefined; }; },
    async prompt(request) { prompts.push(request); running = true; },
    cancel() { cancelCount++; running = false; }, whenIdle: () => idle,
  };
  const voice = createVoiceConversation(ports);
  const emit = (type, data) => { if (type === "turn/end") running = false; listener?.({ type, data }); };
  function claim(turn = 1, requestId = prompts.at(-1).requestId) {
    emit("turn/start", { turn });
    emit("user/message", { source: { kind: "user", rpcId: requestId }, content: [] });
  }
  return { voice, ports, output, prompts, emit, claim, get cancelCount() { return cancelCount; },
    setIdle(promise) { idle = promise; }, sink: event => output.push(event) };
}

test("voice uses native human prompt and streams only its public text and tool status", async () => {
  const f = fixture(); const done = f.voice.speak(1, " Hello ", f.sink);
  assert.equal(f.prompts[0].content[0].text, "Hello");
  assert.equal(f.prompts[0].mode, "queue");
  f.claim();
  f.emit("assistant/chunk", { turn: 1, chunk: { type: "reasoning-delta", text: "private thought" } });
  f.emit("assistant/chunk", { turn: 1, chunk: { type: "text-delta", text: "Hello." } });
  f.emit("tool/call", { turn: 1, callId: "call", name: "subagent", arguments: "private arguments" });
  f.emit("tool/result", { turn: 1, message: { source: { kind: "tool", callId: "call" }, content: [{ type: "tool-result", toolCallId: "call", isError: false, content: [{ text: "private output" }] }] } });
  f.emit("turn/end", { turn: 1, reason: { kind: "completed" } });
  await done;
  assert.deepEqual(f.output.map(x => x.type), ["text", "tool-start", "tool-end", "end"]);
  assert.equal(f.output.at(-1).status, "completed");
  assert.doesNotMatch(JSON.stringify(f.output), /private/);
  await f.voice.close();
});

test("a voice command queues behind background work without speaking its notification", async () => {
  const f = fixture();
  f.ports.running = () => true;
  let idle;
  f.setIdle(new Promise(resolve => { idle = resolve; }));
  const done = f.voice.speak(1, "Next command", f.sink);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].mode, "queue");
  await assert.rejects(f.voice.speak(2, "Another", f.sink), { code: "busy" });
  f.claim(7, "child-notification");
  f.emit("assistant/chunk", { turn: 7, chunk: { type: "text-delta", text: "background only" } });
  f.emit("turn/end", { turn: 7, reason: { kind: "completed" } });
  assert.deepEqual(f.output, []);
  f.claim(8);
  f.emit("assistant/chunk", { turn: 8, chunk: { type: "text-delta", text: "Your answer" } });
  f.emit("turn/end", { turn: 8, reason: { kind: "completed" } });
  idle(); await done;
  assert.deepEqual(f.output.map(event => event.text ?? event.status), ["Your answer", "completed"]);
  await f.voice.close();
});

test("other native turns and plugin messages cannot be spoken as this user's response", async () => {
  const f = fixture(); const done = f.voice.speak(1, "Hello", f.sink);
  f.claim(7, "desktop-other-request");
  f.emit("assistant/chunk", { turn: 7, chunk: { type: "text-delta", text: "wrong" } });
  f.emit("turn/end", { turn: 7, reason: { kind: "completed" } });
  assert.deepEqual(f.output, []);
  f.emit("turn/start", { turn: 8 });
  f.emit("user/message", { source: { kind: "plugin", rpcId: f.prompts[0].requestId } });
  f.emit("assistant/chunk", { turn: 8, chunk: { type: "text-delta", text: "also wrong" } });
  assert.deepEqual(f.output, []);
  f.claim(9);
  f.emit("turn/end", { turn: 9, reason: { kind: "blocked" } });
  await done;
  assert.deepEqual(f.output, [{ type: "end", utterance: 1, status: "blocked" }]);
  await f.voice.close();
});

test("interruption suppresses late text, waits for native quiescence and does not affect a later turn", async () => {
  const f = fixture(); let idle;
  f.setIdle(new Promise(resolve => { idle = resolve; }));
  const first = f.voice.speak(1, "First", f.sink); f.claim();
  const interrupted = f.voice.interrupt(1);
  f.emit("assistant/chunk", { turn: 1, chunk: { type: "text-delta", text: "late" } });
  await assert.rejects(f.voice.speak(2, "Second", f.sink), { code: "busy" });
  idle(); await interrupted; await first;
  const second = f.voice.speak(2, "Second", f.sink); f.claim(2);
  await f.voice.interrupt(1);
  assert.equal(f.cancelCount, 1);
  f.emit("turn/end", { turn: 2, reason: { kind: "completed" } }); await second;
  assert.doesNotMatch(JSON.stringify(f.output), /late/);
  assert.deepEqual(f.output.map(x => x.status), ["aborted", "completed"]);
  await f.voice.close();
});

test("duplicate and oversized admissions fail without replaying commands", async () => {
  const f = fixture();
  for (const [id, text] of [[0, "x"], [1.5, "x"], [1, " "], [1, "é".repeat(8001)]]) {
    await assert.rejects(f.voice.speak(id, text, f.sink), { code: "invalid-utterance" });
  }
  const done = f.voice.speak(1, "Hello", f.sink); f.claim();
  await assert.rejects(f.voice.speak(1, "Hello", f.sink), { code: "already-admitted" });
  f.emit("turn/end", { turn: 1, reason: { kind: "completed" } }); await done;
  await assert.rejects(f.voice.speak(1, "Hello", f.sink), { code: "already-admitted" });
  assert.equal(f.prompts.length, 1);
  await f.voice.close();
});

test("failed admission is reported honestly and its uncertain command is never retried", async () => {
  const f = fixture(); f.ports.prompt = async () => { throw new Error("private backend detail"); };
  await assert.rejects(f.voice.speak(1, "Hello", f.sink), { code: "prompt-failed" });
  await assert.rejects(f.voice.speak(1, "Hello", f.sink), { code: "already-admitted" });
  assert.equal(f.output[0].status, "error");
  assert.doesNotMatch(JSON.stringify(f.output), /private/);
  await f.voice.close();
});

test("closing detaches only voice and cancels only its active parent turn", async () => {
  const f = fixture(); const done = f.voice.speak(1, "Hello", f.sink); f.claim();
  await f.voice.close(); await done; await f.voice.close();
  assert.equal(f.cancelCount, 1);
  f.emit("assistant/chunk", { turn: 1, chunk: { type: "text-delta", text: "late" } });
  assert.equal(f.output.length, 1);
  await assert.rejects(f.voice.speak(2, "Hello", f.sink), { code: "closed" });
});

test("interruption during asynchronous admission waits before cancelling accepted work", async () => {
  const f = fixture(); let admit;
  f.ports.prompt = async () => { await new Promise(resolve => { admit = resolve; }); };
  const turn = f.voice.speak(1, "Pending", f.sink);
  const interrupted = f.voice.interrupt(1);
  assert.equal(f.cancelCount, 0);
  admit(); await interrupted; await turn;
  assert.equal(f.cancelCount, 1);
  assert.deepEqual(f.output, [{ type: "end", utterance: 1, status: "aborted" }]);
  await f.voice.close();
});

test("a native failure before human-message claim settles instead of hanging", async () => {
  const f = fixture();
  await f.voice.speak(1, "Hello", f.sink);
  assert.deepEqual(f.output, [{ type: "end", utterance: 1, status: "error" }]);
  await f.voice.close();
});

test("a disconnected audio sink cannot throw into native event persistence", async () => {
  const f = fixture();
  const done = f.voice.speak(1, "Hello", () => { throw new Error("socket closed"); });
  f.claim();
  assert.doesNotThrow(() => f.emit("assistant/chunk", { turn: 1, chunk: { type: "text-delta", text: "Hello" } }));
  assert.doesNotThrow(() => f.emit("turn/end", { turn: 1, reason: { kind: "completed" } }));
  await done; await f.voice.close();
});

test("a confirmed handoff gets a spoken acknowledgement even when the model emits only a tool call", async () => {
  const f=fixture(),done=f.voice.speak(1,'Bitcoin fiyatına bak',f.sink);f.claim();
  f.emit('tool/call',{turn:1,callId:'task',name:'hub_task'});
  f.emit('tool/result',{turn:1,message:{content:[{type:'tool-result',toolCallId:'task',isError:false}]}});
  f.emit('turn/end',{turn:1,reason:{kind:'completed'}});await done;
  assert.equal(f.output.filter(e=>e.type==='text').length,1);
  assert.match(f.output.find(e=>e.type==='text').text,/HUB’a devrettim/);
  await f.voice.close();
});

test("only completed child-notice replies enter the cursor-based result channel; private blocks and human replies cannot leak", async () => {
  const f=fixture();
  f.emit('turn/start',{turn:2});f.emit('user/message',{source:{kind:'plugin'}});
  f.emit('assistant/message',{turn:2,message:{content:[{type:'text',text:'unrelated plugin reply'}]}});
  f.emit('turn/end',{turn:2,reason:{kind:'completed'}});
  assert.deepEqual(f.voice.notifications(0),{events:[]});
  f.emit('turn/start',{turn:3});f.emit('user/message',{source:{kind:'subagent-settled'}});
  f.emit('assistant/message',{turn:3,message:{content:[{type:'reasoning',text:'private'},{type:'text',text:'hidden text</think>Bitcoin is 100 USD at the quoted time.'}]}});
  assert.deepEqual(f.voice.notifications(0),{events:[]});
  f.emit('turn/end',{turn:3,reason:{kind:'completed'}});
  assert.deepEqual(f.voice.notifications(0),{events:[{id:1,text:'Bitcoin is 100 USD at the quoted time.'}]});
  assert.deepEqual(f.voice.notifications(1),{events:[]});
  assert.deepEqual(f.output,[],'A task result is separate from the human RPC response');
  await f.voice.close();assert.deepEqual(f.voice.notifications(0),{events:[]});
});

test("a result waits while a human turn owns speech; mixed human/child turns are never announced twice", async () => {
  const f=fixture();f.emit('turn/start',{turn:1});f.emit('user/message',{source:{kind:'subagent-settled'}});
  f.emit('assistant/message',{turn:1,message:{content:[{type:'text',text:'A task finished.'}]}});f.emit('turn/end',{turn:1,reason:{kind:'completed'}});
  const done=f.voice.speak(1,'New question',f.sink);f.claim(2);
  assert.deepEqual(f.voice.notifications(0),{events:[]});
  f.emit('user/message',{source:{kind:'subagent-settled'}});
  f.emit('assistant/message',{turn:2,message:{content:[{type:'text',text:'The human answer already covers it.'}]}});
  f.emit('turn/end',{turn:2,reason:{kind:'completed'}});await done;
  assert.deepEqual(f.voice.notifications(0),{events:[{id:1,text:'A task finished.'}]});await f.voice.close();
});
