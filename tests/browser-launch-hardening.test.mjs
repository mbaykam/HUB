import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hardenHarnessBrowserLaunches, inspectHarnessRuntimeProcessPolicy } from '../scripts/harness/runtime-process-policy.mjs';
test('staging hides separately materialized web-app launch entries and remains idempotent',async()=>{
  const root=await mkdtemp(join(tmpdir(),'hub-browser-policy-'));const dir=join(root,'node_modules/@deepseek-ai/dsh-web-app/lib/types');await mkdir(dir,{recursive:true});
  try{await writeFile(join(dir,'index.js'),"import {spawn} from 'node:child_process'; export function open(){return spawn('node',['worker.js'],{stdio:'ignore'});} ");
    assert.equal(await hardenHarnessBrowserLaunches(root),1);assert.equal(await hardenHarnessBrowserLaunches(root),0);
    const report=await inspectHarnessRuntimeProcessPolicy(root);assert.deepEqual(report.violations,[]);
  }finally{await rm(root,{recursive:true,force:true});}
});
