import test from 'node:test';
import assert from 'node:assert/strict';
import {knowledgeLayout,projectKnowledgePreview} from '../packages/harness-overlay/src/client/memory/knowledge-layout.ts';
import {knowledgeLabelStyle} from '../packages/harness-overlay/src/client/memory/knowledge-labels.ts';
const graph=(count=98)=>({nodes:Array.from({length:count},(_,i)=>({id:'record-'+i,title:'Record '+i})),edges:[]});
test('unlinked records occupy a filled 3D cloud, not a ring or one invented domain per record',()=>{
 const result=knowledgeLayout(graph());assert.equal(result.groups.length,1);assert.equal(result.groups[0].name,'Unassigned');
 for(const axis of ['x','y','z'])assert.ok(new Set(result.points.map(p=>Math.round(p[axis]/10))).size>10);
 const radii=result.points.map(p=>Math.hypot(p.x,p.y,p.z));assert.ok(Math.max(...radii)>Math.min(...radii)*2);
 const preview=projectKnowledgePreview(graph());assert.equal(preview.length,64);assert.ok(preview.every(p=>p.x>=0&&p.x<=240&&p.y>=0&&p.y<=110));
});
test('placement is stable across source order and changing the screen size needs no relayout',()=>{
 const g=graph(12);g.edges=[{source:'record-1',target:'record-2'}];const a=knowledgeLayout(g),b=knowledgeLayout({...g,nodes:[...g.nodes].reverse()});assert.deepEqual(a,b);
 assert.deepEqual(projectKnowledgePreview(g),projectKnowledgePreview({...g,nodes:[...g.nodes].reverse()}));
});

test('unassigned records have individual tints without inventing domains; index suggestions color a group alongside canonical domains',()=>{
 const g=graph(8),before=JSON.stringify(g),plain=knowledgeLayout(g);assert.equal(plain.groups.length,1);assert.ok(new Set(plain.points.map(p=>p.color)).size>3);assert.equal(JSON.stringify(g),before);
 g.domains=[{id:'confirmed',title:'Confirmed',status:'active'}];g.memberships=[{nodeId:'record-0',domainId:'confirmed'}];g.communityCandidates={groups:[{id:'local-cluster',label:'Related sources',memberIds:['record-1','record-2','record-0']}]};
 const layout=knowledgeLayout(g);assert.equal(layout.points.find(p=>p.id==='record-0').domainId,'confirmed');const a=layout.points.find(p=>p.id==='record-1'),b=layout.points.find(p=>p.id==='record-2');assert.equal(a.color,b.color);assert.equal(a.domainId,'suggested:local-cluster');assert.deepEqual(a.domainIds,[]);assert.ok(layout.groups.find(g=>g.id===a.domainId).name.startsWith('Suggested'));
});
test('explicit domain hierarchy groups records without inventing factual edges or hiding inactive knowledge',()=>{
 const g=graph(8);g.domains=[{id:'projects',title:'Projects',status:'active'},{id:'hub',title:'HUB',parentId:'projects',status:'active'},{id:'learning',title:'Learning',status:'inactive'}];g.memberships=[{nodeId:'record-0',domainId:'hub'},{nodeId:'record-1',domainId:'projects'},{nodeId:'record-2',domainId:'learning'}];
 const before=JSON.stringify(g),{points,groups}=knowledgeLayout(g),p=id=>points.find(p=>p.id===id);assert.equal(p('record-0').group,p('record-1').group);assert.notEqual(p('record-1').group,p('record-2').group);assert.ok(groups.some(g=>g.name==='Learning'));assert.equal(JSON.stringify(g),before);assert.equal(points.length,8);
});
test('empty and singleton graphs stay finite and preview sampling represents every domain',()=>{
 assert.deepEqual(knowledgeLayout(graph(0)),{points:[],groups:[]});assert.ok(projectKnowledgePreview(graph(1)).every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)));
 const g=graph(100);g.domains=[{id:'a',title:'A',status:'active'},{id:'b',title:'B',status:'active'}];g.memberships=g.nodes.map((n,i)=>({nodeId:n.id,domainId:i<99?'a':'b'}));assert.ok(projectKnowledgePreview(g).some(p=>p.id==='record-99'));
});
test('nested anchors and identity colors remain stable after an unrelated domain is added; focused multi-membership is only a view',()=>{
 const g=graph(25);g.domains=[{id:'a',title:'A',status:'active',createdAt:1},{id:'sub',title:'Sub',parentId:'a',status:'active',createdAt:2},{id:'b',title:'B',status:'active',createdAt:3}];g.memberships=[{nodeId:'record-0',domainId:'sub'},{nodeId:'record-0',domainId:'b'}];const before=JSON.stringify(g),a=knowledgeLayout(g),b=knowledgeLayout({...g,domains:[...g.domains,{id:'later',title:'Later',status:'active',createdAt:4}]});for(const group of a.groups)assert.deepEqual(b.groups.find(v=>v.id===group.id),group);const sub=a.groups.find(v=>v.id==='sub'),parent=a.groups.find(v=>v.id==='a');assert.equal(sub.parentId,'a');assert.ok(Math.hypot(sub.x-parent.x,sub.y-parent.y,sub.z-parent.z)<parent.radius);const focused=knowledgeLayout(g,{focusDomain:'b'}).points.find(p=>p.id==='record-0');assert.equal(focused.domainId,'b');assert.deepEqual(focused.domainIds,['b','sub']);assert.equal(a.points.find(p=>p.id==='record-0').domainIds.length,2);assert.equal(JSON.stringify(g),before);
});
test('edge and membership order are deterministic, large layouts stay finite, and labels scale, fade and retain hysteresis',()=>{
 const g=graph(2500);g.edges=[{source:'record-1',target:'record-2'},{source:'record-2',target:'record-3'}];const a=knowledgeLayout(g),b=knowledgeLayout({...g,edges:[...g.edges].reverse(),nodes:[...g.nodes].reverse()});assert.deepEqual(a,b);assert.ok(a.points.every(p=>Number.isFinite(p.x)&&Number.isFinite(p.y)&&Number.isFinite(p.z)));assert.equal(projectKnowledgePreview(g).length,64);
 const far=knowledgeLabelStyle('node',4),near=knowledgeLabelStyle('node',11),transition=knowledgeLabelStyle('node',7);assert.equal(far.opacity,0);assert.ok(near.opacity>far.opacity&&near.font>far.font);assert.ok(knowledgeLabelStyle('node',7,false,true).opacity>transition.opacity);assert.equal(knowledgeLabelStyle('node',1,true).opacity,1);assert.equal(knowledgeLabelStyle('domain',NaN).opacity,0);
});
