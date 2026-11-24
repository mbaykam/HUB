import test from 'node:test';
import assert from 'node:assert/strict';
import {graphAssets} from '../packages/harness-overlay/src/host/knowledge.ts';

test('pictures shown in replies and files from chats become graph assets linked to their chat',async()=>{
 const file={id:'a'.repeat(64),name:'menu.pdf',mediaType:'application/pdf'};
 const store={
  archive:{async read(id){assert.equal(id,'conversation-noodle');return {messages:[
   {role:'user',text:'Show me small noodle stands ![not mine](https://example.com/user.jpg)'},
   {role:'assistant',text:'Here are two:\n![Par-boil cart](https://images.example.com/cart.jpg)\n![](https://www.street.example/stand.png)',assets:[file]},
  ]};}},
  assets:{async list(){return [];}},
 };
 const graph={nodes:[{id:'conversation-noodle',kind:'conversation',modifiedAt:1}]};
 const assets=await graphAssets(store,graph);
 assert.deepEqual(assets.map(a=>[a.kind,a.title]).sort(),[['file','menu.pdf'],['image','Par-boil cart'],['image','street.example']].sort());
 assert.ok(assets.every(a=>a.conversationIds.join()==='conversation-noodle'));
});
