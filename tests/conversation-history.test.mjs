import test from "node:test";
import assert from "node:assert/strict";
import { openConversationHistory, conversationHistoryDomain } from "@minke/harness-overlay/host/conversation-history.ts";
import {hiddenVoiceConversationIds} from '@minke/harness-overlay/client/host/mobile-conversation-visibility.ts';
import {native} from '../scripts/tests/native-harness-resolver.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

function session(id = "session-voice", extra = {}, events = []) {
  return { id, header: { id, ...extra }, inheritedEventCount: 0, snapshotEvents: () => events };
}
function storage() {
  const values = new Map();
  let fail = false, writes = 0;
  const table = {
    get: id => values.get(id), entries: () => values.entries(), get size() { return values.size; },
    async put(id, value) {
      if (fail) throw new Error("Synthetic durability failure");
      values.set(id, conversationHistoryDomain.tables.voice.valueSchema.parse(value)); writes++;
    },
    async update(id, transform) { const value = transform(values.get(id)); await table.put(id, value); return value; },
  };
  return { async open(spec) { assert.equal(spec.name, "hub_conversations"); return { table: () => table, async close() {} }; },
    seed: (id,value)=>table.put(id,value),set fail(value) { fail = value; }, get writes() { return writes; } };
}

test("new voice conversations are immediately visible in Recents and stay visible after reopening without a save call", async () => {
  const backing = storage(); const history = await openConversationHistory(backing);
  const s = session(); await history.markVoiceOrigin(s); await history.markVoiceOrigin(s);
  assert.deepEqual(history.view(s.id), { kind: "voice", saved: true });
  assert.deepEqual(hiddenVoiceConversationIds(history.snapshot(),{[s.id]:{}}),[]);
  assert.equal(backing.writes, 1);
  s.snapshotEvents().push({ type: "user/message", data: { text: "A spoken detail" } });
  const original = structuredClone(s.snapshotEvents());
  assert.deepEqual(await history.save(s.id), { kind: "voice", saved: true });
  await history.save(s.id);
  assert.equal(backing.writes, 1,'Save is unnecessary and idempotent for a new voice conversation');
  assert.deepEqual(s.snapshotEvents(), original);
  await history.close();
  const reopened = await openConversationHistory(backing);
  assert.deepEqual(reopened.view(s.id), { kind: "voice", saved: true });
  assert.deepEqual(hiddenVoiceConversationIds(reopened.snapshot(),{[s.id]:{}}),[]);
  assert.deepEqual(Object.keys(reopened.snapshot()[0]).sort(), ["createdAt", "saved", "sessionId"]);
});

test("ordinary text history cannot be retroactively hidden when voice attaches", async () => {
  const history = await openConversationHistory(storage());
  const s = session("typed", {}, [{ type: "user/message" }]);
  await assert.rejects(history.markVoiceOrigin(s), /new empty/);
  assert.deepEqual(history.view(s.id), { kind: "chat", saved: true });
  await assert.rejects(history.save(s.id), /not an archived/);
});

test("delegated tasks and forks never inherit a voice parent's hidden classification", async () => {
  const history = await openConversationHistory(storage());
  const parent = session(); await history.markVoiceOrigin(parent);
  for (const origin of ["subagent", undefined]) {
    const child = session("child", { origin }); child.inheritedEventCount = 1;
    assert.deepEqual(history.view(child.id, origin), { kind: origin ? "task" : "chat", saved: true });
    await assert.rejects(history.markVoiceOrigin(child), /new empty/);
    await assert.rejects(history.save(child.id), /not an archived/);
  }
});

test("failed durable writes do not advertise a new voice record or a legacy promotion", async () => {
  const backing = storage(); const history = await openConversationHistory(backing); const s = session();
  backing.fail = true;
  await assert.rejects(history.markVoiceOrigin(s), /durability/);
  assert.deepEqual(history.view(s.id), { kind: "chat", saved: true });
  backing.fail = false; await backing.seed(s.id,{saved:false,createdAt:1});backing.fail = true;
  await assert.rejects(history.save(s.id), /durability/);
  assert.deepEqual(history.view(s.id), { kind: "voice", saved: false });
});

test('the new default does not expose older hidden voice conversations or rewrite their visibility',async()=>{
 const backing=storage();await backing.seed('legacy',{saved:false,createdAt:1});
 const history=await openConversationHistory(backing);await history.markVoiceOrigin(session('legacy'));await history.markVoiceOrigin(session('new'));
 assert.deepEqual(history.view('legacy'),{kind:'voice',saved:false});assert.deepEqual(history.view('new'),{kind:'voice',saved:true});
 assert.deepEqual(hiddenVoiceConversationIds(history.snapshot(),{legacy:{},new:{}}),['legacy']);await history.close();
});

test('native JSON storage retains automatic Recents visibility across a host restart',async()=>{
 const {Context}=await native('@deepseek-ai/cordis'),{default:Storage}=await native('@deepseek-ai/dsh-storage');
 const {DomainFacility}=await native('@deepseek-ai/dsh-storage-domain'),{JsonStorageBackend}=await native('@deepseek-ai/dsh-storage-json');
 const root=await mkdtemp(join(tmpdir(),'hub-eval-voice-recents-')),contexts=[];
 const mount=async()=>{const ctx=new Context();contexts.push(ctx);await ctx.plugin(Storage);const backend=new JsonStorageBackend(root);ctx.storage.backend.register('json',backend);const facility=new DomainFacility(ctx,{backend:'json'});ctx.storage.mount('domain',facility);return {ctx,history:await openConversationHistory(facility)};};
 try{
  const first=await mount(),id='hub-eval-voice-recents';await first.history.markVoiceOrigin(session(id));
  const before=first.history.snapshot();assert.equal(before[0].saved,true);await first.history.close();await first.ctx.fiber.dispose();
  const reopened=await mount();assert.deepEqual(reopened.history.snapshot(),before);
  assert.deepEqual(hiddenVoiceConversationIds(reopened.history.snapshot(),{[id]:{}}),[]);
  await reopened.history.close();
 }finally{for(const ctx of contexts)await ctx.fiber.dispose();assert.ok(root.startsWith(join(tmpdir(),'hub-eval-voice-recents-')));await rm(root,{recursive:true,force:true});}
});
