import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {createKnowledgeCloud} from '../packages/harness-overlay/src/client/memory/knowledge-brain-view.ts';
import {knowledgeFitPose} from '../packages/harness-overlay/src/client/memory/knowledge-camera.ts';
import {placeKnowledgeLabel,knowledgeLabelStyle} from '../packages/harness-overlay/src/client/memory/knowledge-labels.ts';
const graph=count=>({nodes:Array.from({length:count},(_,i)=>({id:`record-${String(i).padStart(4,'0')}`,title:`Record ${i}`})),edges:[]});

test('overview root labels find non-overlapping callouts while ordinary labels retain detail LOD',()=>{
 const boxes=[],base={x:100,y:200,width:110,height:24};for(let i=0;i<5;i++){const next=placeKnowledgeLabel(base,{width:390,height:600},boxes,'root');assert.ok(next);assert.ok(!boxes.some(box=>next.box.x<box.x+box.width&&next.box.x+next.box.width>box.x&&next.box.y<box.y+box.height&&next.box.y+next.box.height>box.y));boxes.push(next.box);}
 assert.equal(placeKnowledgeLabel(base,{width:390,height:600},boxes,'node'),undefined);assert.ok(knowledgeLabelStyle('root',7).opacity>0);assert.equal(knowledgeLabelStyle('node',7).opacity,0);
});

test('initial fit chooses a separated deterministic camera without changing root coordinates',()=>{
 const groups=[{id:'a',x:300,y:10,z:0,radius:100,members:['a']},{id:'b',x:300,y:10,z:270,radius:100,members:['b']},{id:'c',x:-250,y:200,z:-50,radius:100,members:['c']}],before=JSON.stringify(groups),pose=knowledgeFitPose(groups);
 assert.deepEqual(pose,knowledgeFitPose([...groups].reverse()));assert.equal(JSON.stringify(groups),before);assert.ok(Number.isFinite(pose.yaw)&&Number.isFinite(pose.pitch));
 const separation=({yaw,pitch})=>{const points=groups.map(g=>{const x=g.x*Math.cos(yaw)-g.z*Math.sin(yaw),z=g.x*Math.sin(yaw)+g.z*Math.cos(yaw);return {x,y:g.y*Math.cos(pitch)-z*Math.sin(pitch)};});return Math.min(...points.flatMap((p,i)=>points.slice(i+1).map(q=>Math.hypot(p.x-q.x,p.y-q.y))));};
 assert.ok(separation(pose)>separation({yaw:.2,pitch:.12}));
});

test('selecting the first record does not collapse a filled cloud to one node; draw budgets only limit the view',t=>{
 const dom=new JSDOM('<body data-ds-dark-theme></body>'),view=dom.window,frames=new Map();let frameId=0;
 view.requestAnimationFrame=fn=>{frames.set(++frameId,fn);return frameId;};view.cancelAnimationFrame=id=>frames.delete(id);view.ResizeObserver=class{observe(){}disconnect(){}};
 const noop=()=>{},ctx=new Proxy({measureText:text=>({width:text.length*7}),createRadialGradient:()=>({addColorStop:noop})},{get:(object,key)=>key in object?object[key]:noop,set:(object,key,value)=>(object[key]=value,true)});
 view.HTMLCanvasElement.prototype.getContext=()=>ctx;view.HTMLCanvasElement.prototype.getBoundingClientRect=()=>({x:0,y:0,left:0,top:0,width:390,height:600});
 const cloud=createKnowledgeCloud(view.document,noop);view.document.body.append(cloud.canvas);t.after(()=>{cloud.dispose();dom.window.close();});const draw=()=>{for(const [id,fn]of [...frames]){frames.delete(id);fn();}};
 const initial=graph(100);cloud.update(initial);draw();assert.equal(cloud.canvas.dataset.sampledNodes,'100');cloud.select(initial.nodes[0].id);draw();assert.equal(cloud.canvas.dataset.sampledNodes,'100');assert.equal(cloud.canvas.dataset.shownNodes,'100');
 cloud.canvas.setPointerCapture=()=>{};const pointer=(type,id,x,y)=>{const event=new view.Event(type);Object.assign(event,{pointerId:id,clientX:x,clientY:y});cloud.canvas.dispatchEvent(event);};pointer('pointerdown',1,100,100);pointer('pointerdown',2,180,100);pointer('pointermove',2,220,100);draw();assert.equal(cloud.canvas.dataset.zoom,'1.50');pointer('pointercancel',2,220,100);pointer('pointercancel',1,100,100);cloud.canvas.dispatchEvent(new view.KeyboardEvent('keydown',{key:'Home'}));draw();assert.equal(cloud.canvas.dataset.zoom,'1.00');assert.equal(frames.size,0,'Idle rendering does not keep an animation loop running');
 const dense=graph(650);for(let i=0;i<70;i++)for(let j=i+1;j<70;j++)dense.edges.push({source:dense.nodes[i].id,target:dense.nodes[j].id});cloud.update(dense);draw();assert.ok(Number(cloud.canvas.dataset.sampledNodes)<=500);assert.ok(Number(cloud.canvas.dataset.shownEdges)<=1200);assert.equal(dense.nodes.length,650);assert.equal(dense.edges.length,2415);
});
