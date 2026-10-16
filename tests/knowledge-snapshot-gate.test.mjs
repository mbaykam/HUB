import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate} from 'node:timers/promises';
import {KnowledgeMutationGate} from '../packages/harness-overlay/src/host/knowledge-mutation-gate.ts';
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
test('snapshot drains admitted nested writers and blocks new capture until its copy finishes',async()=>{
 const gate=new KnowledgeMutationGate(),held=deferred(),copy=deferred(),events=[];
 const first=gate.run(async()=>{events.push('first');await held.promise;await gate.run(async()=>events.push('nested'));});
 const snapshot=gate.snapshot(async()=>{events.push('snapshot');await copy.promise;events.push('verified');});await setImmediate();
 const later=gate.run(async()=>events.push('later'));await setImmediate();assert.deepEqual(events,['first']);held.resolve();await first;await setImmediate();assert.deepEqual(events,['first','nested','snapshot']);copy.resolve();await Promise.all([snapshot,later]);assert.deepEqual(events,['first','nested','snapshot','verified','later']);
});
test('failed snapshots reopen admission and concurrent exports serialize without blocking themselves',async()=>{
 const gate=new KnowledgeMutationGate(),held=deferred(),events=[];const first=gate.snapshot(async()=>{events.push('first');await held.promise;throw Error('Copy failed');});await setImmediate();const second=gate.snapshot(async()=>events.push('second'));const write=gate.run(async()=>events.push('write'));held.resolve();await assert.rejects(first,/Copy failed/);await Promise.all([second,write]);assert.ok(events.includes('write'));assert.equal(events[0],'first');
 await gate.run(async()=>assert.rejects(gate.snapshot(async()=>{}),/inside a mutation/));
});
