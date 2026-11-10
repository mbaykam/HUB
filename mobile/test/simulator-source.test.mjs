import test from 'node:test';
import assert from 'node:assert/strict';
import {validateSimulatorSource,selectSimulatorSeed} from '../scripts/simulator-source.mjs';
const sha='a'.repeat(40),identity={runId:'123',sha,repository:'mbaykam/HUB'};
const run={id:123,status:'completed',conclusion:'success',event:'workflow_dispatch',head_branch:'main',head_sha:sha,path:'.github/workflows/ios-simulator.yml',repository:{full_name:'mbaykam/HUB'},head_repository:{full_name:'mbaykam/HUB'}};
const artifact={id:456,name:'HUB-ios-simulator-'+sha,expired:false,size_in_bytes:15000000};
test('simulator isolation never selects running/unavailable devices or non-iPhone runtimes',()=>{
 const id='A'.repeat(8)+'-AAAA-AAAA-AAAA-'+'A'.repeat(12),phone={udid:id,name:'iPhone fixture',state:'Shutdown',isAvailable:true};
 const runtime='com.apple.CoreSimulator.SimRuntime.iOS-26-5';
 assert.deepEqual(selectSimulatorSeed({[runtime]:[{...phone,state:'Booted'},phone]}),{runtime,seed:id});
 for(const bad of [{...phone,state:'Booted'},{...phone,isAvailable:false},{...phone,name:'iPad fixture'},{...phone,udid:'unsafe'}])assert.throws(()=>selectSimulatorSeed({[runtime]:[bad]}));
 assert.throws(()=>selectSimulatorSeed({'watchOS-26':[phone]}));
});
test('only a successful exact main-branch simulator build is eligible for native execution',()=>{
 assert.equal(validateSimulatorSource(run,[artifact],identity).artifactId,456);
 for(const change of [{event:'pull_request'},{head_branch:'feature'},{head_sha:'b'.repeat(40)},{conclusion:'failure'},{path:'.github/workflows/other.yml'},{head_repository:{full_name:'foreign/fork'}}])assert.throws(()=>validateSimulatorSource({...run,...change},[artifact],identity));
});
test('execution rejects expired, missing, duplicate or oversized artifacts and shell-like inputs',()=>{
 for(const artifacts of [[],[{...artifact,expired:true}],[artifact,artifact],[{...artifact,size_in_bytes:300000000}]])assert.throws(()=>validateSimulatorSource(run,artifacts,identity));
 for(const change of [{runId:'123; command'},{sha:'main'},{repository:'foreign/fork'}])assert.throws(()=>validateSimulatorSource(run,[artifact],{...identity,...change}));
});
