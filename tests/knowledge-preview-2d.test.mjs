import test from 'node:test';
import assert from 'node:assert/strict';
import {JSDOM} from '../vendor/deepseek-harness/node_modules/jsdom/lib/api.js';
import {createKnowledgePreview2D} from '../packages/harness-overlay/src/client/memory/knowledge-preview-2d.ts';
test('Home 2D preview draws only factual edges, keeps domain colors and opens exact records by keyboard',()=>{
 const dom=new JSDOM('<main></main>'),root=dom.window.document,opened=[],preview=createKnowledgePreview2D(root,id=>opened.push(id));root.querySelector('main').append(preview.panel);
 try{preview.update({nodes:[{id:'a',title:'First note'},{id:'b',title:'Second note'},{id:'c',title:'Other domain'}],edges:[{source:'a',target:'b'},{source:'a',target:'unavailable'}],domains:[{id:'one',title:'First domain',status:'active'},{id:'two',title:'Second domain',status:'active'}],memberships:[{nodeId:'a',domainId:'one'},{nodeId:'b',domainId:'one'},{nodeId:'c',domainId:'two'}]});
 assert.equal(preview.panel.querySelectorAll('line').length,1);assert.equal(preview.panel.querySelectorAll('svg [role=button]').length,3);assert.deepEqual([...preview.panel.querySelectorAll('svg text')].map(n=>n.textContent).sort(),['First domain','Second domain']);const dots=preview.panel.querySelectorAll('svg g circle:last-of-type');assert.equal(dots[0].getAttribute('fill'),dots[1].getAttribute('fill'));assert.notEqual(dots[1].getAttribute('fill'),dots[2].getAttribute('fill'));
 const svg=preview.panel.querySelector('svg'),initial=svg.getAttribute('viewBox');preview.panel.querySelector('[aria-label="Zoom in preview"]').click();assert.notEqual(svg.getAttribute('viewBox'),initial);preview.panel.querySelector('[aria-label="Fit preview"]').click();assert.equal(svg.getAttribute('viewBox'),initial);preview.panel.querySelector('[aria-label="Read Second note"]').dispatchEvent(new dom.window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));assert.deepEqual(opened,['b']);
 preview.update({nodes:[],edges:[]});assert.ok(svg.getAttribute('viewBox').split(' ').every(n=>Number.isFinite(Number(n))));assert.equal(svg.querySelectorAll('g').length,0);preview.dispose();assert.equal(root.querySelector('main').children.length,0);
 }finally{dom.window.close();}
});
