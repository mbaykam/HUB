import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {preservePnpmWorkspace} from '../scripts/harness/pnpm-workspace-guard.mjs';

const original="packages:\n  - packages/*\nminimumReleaseAgeExclude:\n  # Reviewed exact version\n  - 'original@1.2.3'\n\npatchedDependencies:\n  native@1.0.0: patches/native.patch\n";
const appended=original.replace("\n\npatchedDependencies:","\n  - '@aws-sdk/credential-provider-http@3.972.77'\n\npatchedDependencies:");
async function fixture(run){const root=await mkdtemp(join(tmpdir(),'hub-pnpm-policy-'));const path=join(root,'pnpm-workspace.yaml');try{await writeFile(path,original);await run(path);}finally{await rm(root,{recursive:true,force:true});}}

test('deployment restores only generated pnpm policy additions and preserves original bytes',()=>fixture(async path=>{
 const bytes=original.replaceAll('\n','\r\n');await writeFile(path,bytes);
 const result=await preservePnpmWorkspace(path,async()=>{await writeFile(path,appended);return 42;});
 assert.equal(result,42);assert.equal(await readFile(path,'utf8'),bytes);
}));
test('failed deployment still removes only its generated bookkeeping',()=>fixture(async path=>{
 await assert.rejects(preservePnpmWorkspace(path,async()=>{await writeFile(path,appended);throw Error('deploy failed');}),/deploy failed/);
 assert.equal(await readFile(path,'utf8'),original);
}));
test('unexpected dependency, comment and policy removals remain visible rather than overwritten',()=>fixture(async path=>{
 for(const changed of [appended.replace('native.patch','changed.patch'),appended.replace('Reviewed exact version','User comment'),appended.replace("  - 'original@1.2.3'\n",''),appended.replace('@aws-sdk/credential-provider-http@3.972.77','*')]){
  await writeFile(path,original);
  await assert.rejects(preservePnpmWorkspace(path,async()=>writeFile(path,changed)),/preserving the changed file/);
  assert.equal(await readFile(path,'utf8'),changed);
 }
}));
