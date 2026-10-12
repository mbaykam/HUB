import test from 'node:test';
import assert from 'node:assert/strict';
import {requestedCharacterHandoff,currentUserText} from '@minke/harness-overlay/host/character-handoff.ts';
const characters=[{id:'hub',name:'HUB'},{id:'mira',name:'Mira'},{id:'punctuation',name:'A+B'},{id:'devil',name:'Devil'}];
test('direct bilingual character requests select a speaker without treating work as a handoff',()=>{
 for(const text of ['Get mira','Please get me Mira.','Call Mira','Let me speak with Mira','Switch to Mira','Mira’yı çağır','Mira ile konuşmak istiyorum'])assert.equal(requestedCharacterHandoff(text,characters)?.id,'mira',text);
 for(const text of ['Go back to HUB','HUB’a geri dön'])assert.equal(requestedCharacterHandoff(text,characters)?.id,'hub',text);
 assert.equal(requestedCharacterHandoff('Get A+B',characters)?.id,'punctuation');
 for(const text of ['Ask Mira to research Bitcoin','Get Mira to research Bitcoin','Get me Mira and research Bitcoin','The website says: Get Mira','"Get Mira"','Tell me about Mira','What model are you running?'])assert.equal(requestedCharacterHandoff(text,characters),undefined,text);
});
test('completion notices and an earlier human turn cannot authorize a switch',()=>{
 const events=[{type:'turn/start'},{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Get Mira'}]}}];
 const agent={session:{snapshotEvents:()=>events}};
 assert.equal(currentUserText(agent),'Get Mira');
 events.push({type:'turn/end'},{type:'turn/start'},{type:'user/message',data:{source:{kind:'agent-message'},content:[{type:'text',text:'Get Mira'}]}});
 assert.equal(currentUserText(agent),undefined);
});
