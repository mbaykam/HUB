import test from 'node:test';
import assert from 'node:assert/strict';
import {voiceTopicTitle,installVoiceTitles} from '../packages/harness-overlay/src/host/voice-titles.ts';
const user=(seq,text)=>({type:'user/message',seq,data:{source:{kind:'user'},content:[{type:'text',text}]}});
test('voice topics ignore greetings and save commands, preserve languages and fit native UTF-8 titles',()=>{
 const events=[user(0,'Hello.'),user(1,'Can you hear me?'),user(2,'Compare train routes to Edinburgh'),user(3,'İskoçya için hafta sonu planı'),user(4,'Save this conversation')];
 const title=voiceTopicTitle(events);assert.match(title.title,/Edinburgh/);assert.match(title.title,/İskoçya/);assert.deepEqual(title.messageSeqs,[2,3]);assert.equal(title.source.kind,'fallback');
 assert.equal(voiceTopicTitle([user(0,'Merhaba!')]),undefined);assert.ok(Buffer.byteLength(voiceTopicTitle([user(0,'界'.repeat(200))]).title)<=76);
});
test('native titles follow voice topics after late provider titles but respect human names and ordinary chats',()=>{
 let listener,removed=false;const ctx={on:(name,fn)=>{listener=fn;return()=>removed=true;}};
 const events=[user(0,'Solar battery sizing for a small house')],session={header:{id:'voice'},snapshotEvents:()=>events,append:(type,data)=>{events.push({type,data});listener(session,{type,data});}};
 const off=installVoiceTitles(ctx,{view:id=>({kind:id==='voice'?'voice':'chat'})});
 listener(session,{type:'turn/end'});assert.match(events.at(-1).data.title,/Solar battery/);
 events.push({type:'session/title',data:{title:'Greeting',source:{kind:'provider'}}});listener(session,events.at(-1));assert.match(events.at(-1).data.title,/Solar battery/);
 events.push({type:'session/title',data:{title:'My custom name',source:{kind:'user'}}});listener(session,{type:'turn/end'});assert.equal(events.at(-1).data.title,'My custom name');
 session.header.id='ordinary';const before=events.length;listener(session,{type:'turn/end'});assert.equal(events.length,before);off();assert.equal(removed,true);
});
