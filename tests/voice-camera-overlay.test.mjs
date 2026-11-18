import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {VoiceScreenFrames,parseScene} from '../packages/harness-overlay/src/host/voice-screen.ts';
import {attachVoiceScreenTool,zoomRegion,describeMarks,parseOverlayItems,OVERLAY_TOOL,SCREEN_VIEW_TOOL} from '../packages/harness-overlay/src/host/voice-screen-tool.ts';

const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url');
const scene={source:'camera',marks:[{id:1,label:'Router',text:'AX55',x:0.5,y:0.3,width:0.2,height:0.1},{id:2,label:'Cable',x:0.1,y:0.7,width:0.1,height:0.1}]};

test('the phone scene header is parsed defensively',()=>{
 const parsed=parseScene(encode({marks:[{id:1,label:'  Router ',text:'AX55',x:0.5,y:0.3,width:0.2,height:0.1},{id:1,x:0,y:0,width:0.1,height:0.1},{id:200,x:0,y:0,width:0.1,height:0.1},{id:3,x:2,y:0,width:0.1,height:0.1},{id:4,x:0.95,y:0,width:0.3,height:0.1}]}),'camera');
 assert.equal(parsed.source,'camera');
 assert.deepEqual(parsed.marks.map(m=>m.id),[1,4],'duplicates, out-of-range ids and coordinates are dropped');
 assert.equal(parsed.marks[0].label,'Router');assert.ok(Math.abs(parsed.marks[1].width-0.05)<1e-9,'boxes are clipped to the frame');
 for(const bad of [undefined,'','not base64!',encode({marks:'x'}),'a'.repeat(13000)])assert.deepEqual(parseScene(bad,'screen'),{source:'screen',marks:[]});
});

test('zoom takes a grid cell or a mark, and marks read as one short line each',()=>{
 assert.deepEqual(zoomRegion('c3',scene),{x:0.4,y:0.4,width:0.2,height:0.2,label:'C3'});assert.deepEqual(zoomRegion('E5',scene),{x:0.8,y:0.8,width:0.2,height:0.2,label:'E5'});
 const mark=zoomRegion('#1',scene);assert.equal(mark.label,'#1');assert.ok(mark.x<=0.5&&mark.x+mark.width>=0.7&&mark.width>=0.2);
 for(const bad of ['F1','A6','#9','top'])assert.throws(()=>zoomRegion(bad,scene));
 assert.deepEqual(describeMarks(scene),['#1 Router "AX55" at 0.50,0.30 size 0.20x0.10','#2 Cable at 0.10,0.70 size 0.10x0.10']);
});

test('overlay items target marks or points, and zoomed points map back onto the frame',()=>{
 assert.deepEqual(parseOverlayItems([{mark:1,style:'arrow',label:'This port'}],scene,undefined,false),[{mark:1,style:'arrow',label:'This port'}]);
 const zoom={x:0.25,y:0.5,width:0.25,height:0.25,label:'B3'};
 const [point]=parseOverlayItems([{x:0.5,y:0.5,style:'circle',step:2}],scene,zoom,true);
 assert.deepEqual(point,{x:0.375,y:0.625,style:'circle',step:2});
 const [box]=parseOverlayItems([{x:0,y:0,width:1,height:1,style:'box'}],scene,zoom,true);
 assert.deepEqual(box,{x:0.25,y:0.5,width:0.25,height:0.25,style:'box'});
 assert.throws(()=>parseOverlayItems([{mark:7}],scene,undefined,false),/no mark #7/);
 assert.throws(()=>parseOverlayItems([{x:0.5}],scene,undefined,false),/x and y/);
 assert.throws(()=>parseOverlayItems([{x:0.5,y:0.5,style:'laser'}],scene,undefined,false),/style/);
 assert.throws(()=>parseOverlayItems([{x:0.5,y:0.5}],scene,undefined,true),/in_zoom/);
 assert.throws(()=>parseOverlayItems(Array(9).fill({mark:1}),scene,undefined,false),/zero to eight/);
});

test('the share keeps the scene and offers overlays only to its own call',()=>{
 let clock=1000;const frames=new VoiceScreenFrames(async()=>{},()=>clock),owner={callId:'call',sessionId:'chat'},share=randomUUID();
 assert.throws(()=>frames.overlay('chat',[],'',0,true),/not shared/);
 frames.start(owner,share);
 const id=frames.overlay('chat',[{mark:1,style:'arrow'}],'Plug in here',4,true);
 const status=frames.status(owner);
 assert.equal(status.overlay.id,id);assert.equal(status.overlay.sequence,4);assert.equal(status.overlay.clear,true);assert.equal(status.overlay.items[0].mark,1);
 assert.equal(frames.status({callId:'other',sessionId:'chat'}).overlay,undefined);
 frames.stop(owner,share);assert.equal(frames.status(owner).overlay,undefined);
});

const user=()=>[{type:'turn/start'},{type:'user/message',data:{source:{kind:'user'}}}];
function camera(frameScene=scene){
 const tools=new Map(),overlays=[],crops=[];let saves=0;
 const agent={id:'chat',session:{header:{},snapshotEvents:()=>user()},ctx:{tools:{register(d){tools.set(d.name,d);return()=>tools.delete(d.name);}},systemPrompt:{section(v){agent.guidance=v.text;return()=>{};}}}};
 const frame={bytes:Buffer.from('full-frame'),shareId:'s',sequence:9,remainingMs:4000,scene:frameScene};
 let time=10000;
 const off=attachVoiceScreenTool(agent,{current:()=>({callId:'call',sessionId:'chat'}),frame:()=>frame,vision:async()=>true,allowed:()=>true,now:()=>time,
  save:async bytes=>{saves++;return{attachmentId:'a'+saves,bytes:bytes.toString()};},
  transform:async(bytes,region,max)=>{crops.push({region,max});return Buffer.from(region?'crop':'overview');},
  overlay:(sessionId,items,note,sequence,clear)=>{overlays.push({sessionId,items,note,sequence,clear});return 'o'+overlays.length;}});
 return {agent,tools,overlays,crops,saves:()=>saves,off,exec:{agent,signal:new AbortController().signal}};
}

test('a marks read costs no image; zoom crops the full frame; overlays land on the frame that was seen',async()=>{
 const c=camera();try{
  const view=c.tools.get(SCREEN_VIEW_TOOL),overlay=c.tools.get(OVERLAY_TOOL);
  assert.match(c.agent.guidance,/5x5 grid/);assert.match(c.agent.guidance,/hub_show_overlay/);
  await assert.rejects(overlay.execute({items:[{mark:1}]},c.exec),/Look first/);
  const marks=await view.execute({detail:'marks'},c.exec);
  assert.equal(c.saves(),0);assert.equal(marks.marks.length,2);assert.equal(marks.source,'camera');
  const overview=await view.execute({},c.exec);
  assert.equal(c.crops[0].region,undefined);assert.equal(c.crops[0].max,768);assert.equal(overview.source,'camera');assert.equal(overview.marks.length,2);
  const zoomed=await view.execute({zoom:'B3'},c.exec);
  assert.deepEqual(c.crops[1].region,{x:0.2,y:0.4,width:0.2,height:0.2,label:'B3'});assert.equal(c.crops[1].max,1024);assert.equal(zoomed.zoom.cell,'B3');
  const shown=await overlay.execute({items:[{x:0.5,y:0.5,style:'step',step:1,label:'Press'}],in_zoom:true,note:'Hold for 5 s'},c.exec);
  assert.equal(shown.shown,true);
  assert.deepEqual(c.overlays[0],{sessionId:'chat',items:[{x:0.30000000000000004,y:0.5,style:'step',label:'Press',step:1}],note:'Hold for 5 s',sequence:9,clear:true});
  await overlay.execute({items:[],clear:true},c.exec);assert.deepEqual(c.overlays[1].items,[]);
  await assert.rejects(view.execute({zoom:'Z9'},c.exec),/grid cell/);
  await assert.rejects(view.execute({sessionId:'other'},c.exec),/only detail and zoom/);
 }finally{c.off();assert.equal(c.tools.size,0);}
});

test('overlays refuse a shared screen, which keeps its notification highlights',async()=>{
 const c=camera({source:'screen',marks:[]});try{
  await c.tools.get(SCREEN_VIEW_TOOL).execute({detail:'marks'},c.exec);
  await assert.rejects(c.tools.get(OVERLAY_TOOL).execute({items:[{x:0.5,y:0.5}]},c.exec),/hub_highlight_screen/);
 }finally{c.off();}
});
