import test from 'node:test';
import assert from 'node:assert/strict';
import {currentTurnHasUserRequest} from '@minke/harness-overlay/host/task-turn.ts';
test('handoff authorization accepts genuine user turns independently of language or wording',()=>{
 for(const content of [[{type:'text',text:"Biraz Mira’yla sohbet etmek istiyorum."}],[{type:'text',text:"I'd like your other assistant to take over our conversation."}],[{type:'image',source:{url:'fixture'}}]]){
  const agent={session:{snapshotEvents:()=>[{type:'turn/start'},{type:'user/message',data:{source:{kind:'user'},content}}]}};
  assert.equal(currentTurnHasUserRequest(agent),true);
 }
});
test('completion notices and an earlier human turn cannot authorize a switch',()=>{
 const events=[{type:'turn/start'},{type:'user/message',data:{source:{kind:'user'},content:[{type:'text',text:'Get Mira'}]}}];
 const agent={session:{snapshotEvents:()=>events}};
 assert.equal(currentTurnHasUserRequest(agent),true);
 events.push({type:'turn/end'},{type:'turn/start'},{type:'user/message',data:{source:{kind:'agent-message'},content:[{type:'text',text:'Get Mira'}]}});
 assert.equal(currentTurnHasUserRequest(agent),false);
});
