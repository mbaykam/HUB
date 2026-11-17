import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {VoiceScreenFrames,parseScreenRegions} from '../packages/harness-overlay/src/host/voice-screen.ts';
import {attachVoiceScreenTool} from '../packages/harness-overlay/src/host/voice-screen-tool.ts';

test('highlight regions must be one to six normalized boxes',()=>{
 assert.deepEqual(parseScreenRegions([{x:0.1,y:0.2,width:0.3,height:0.1,label:'  Settings  '}]),[{x:0.1,y:0.2,width:0.3,height:0.1,label:'Settings'}]);
 for(const bad of [[],null,[{x:0.9,y:0,width:0.2,height:0.1}],[{x:0,y:0,width:0,height:0.1}],Array(7).fill({x:0,y:0,width:0.1,height:0.1})])assert.throws(()=>parseScreenRegions(bad));
});

test('a highlight is offered only for the current share and expires',()=>{
 let clock=1000;const frames=new VoiceScreenFrames(async()=>{},()=>clock),owner={callId:'call',sessionId:'chat'},share=randomUUID();
 assert.throws(()=>frames.highlight('chat',[{x:0,y:0,width:0.5,height:0.5}],'n'),/not active/);
 frames.start(owner,share);
 const id=frames.highlight('chat',[{x:0.1,y:0.1,width:0.2,height:0.2,label:'Tap here'}],'Open settings');
 const status=frames.status(owner);
 assert.equal(status.highlight.id,id);assert.equal(status.highlight.note,'Open settings');assert.equal(status.highlight.regions[0].label,'Tap here');
 assert.equal(frames.status({callId:'other',sessionId:'chat'}).highlight,undefined);
 frames.stop(owner,share);assert.equal(frames.status(owner).highlight,undefined);
 clock+=61_000;frames.start(owner,randomUUID());assert.equal(frames.status(owner).highlight,undefined,'A new share never shows an old mark');
});

test('the assistant marks the shared screen through hub_highlight_screen',async()=>{
 const tools=new Map(),marks=[];
 const agent={id:'chat',session:{header:{},snapshotEvents:()=>[]},ctx:{tools:{register(d){tools.set(d.name,d);return()=>tools.delete(d.name);}},systemPrompt:{section(){return()=>{};}}}};
 const off=attachVoiceScreenTool(agent,{current:()=>({callId:'call',sessionId:'chat'}),frame:()=>undefined,vision:async()=>true,save:async()=>({}),allowed:()=>true,
  highlight:(sessionId,regions,note)=>{marks.push({sessionId,regions,note});return 'mark-1';}});
 const tool=tools.get('hub_highlight_screen');assert.ok(tool);
 const value=await tool.execute({regions:[{x:0.5,y:0.5,width:0.2,height:0.1,label:'Wi-Fi'}],note:'Tap Wi-Fi'},{agent,signal:new AbortController().signal});
 assert.equal(value.shown,true);assert.deepEqual(marks[0],{sessionId:'chat',regions:[{x:0.5,y:0.5,width:0.2,height:0.1,label:'Wi-Fi'}],note:'Tap Wi-Fi'});
 await assert.rejects(tool.execute({regions:[]},{agent,signal:new AbortController().signal}),/one to six/);
 off();assert.equal(tools.size,0);
});
