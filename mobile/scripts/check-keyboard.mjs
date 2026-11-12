import {execFileSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {selectSimulatorSeed} from './simulator-source.mjs';

if(process.platform!=='darwin')throw Error('Real keyboard checks require macOS/Xcode.');
const output=resolve('mobile/build/keyboard-accessory'),evidence=resolve(output,'evidence');
await mkdir(evidence,{recursive:true});
const env=Object.fromEntries(['PATH','HOME','TMPDIR','DEVELOPER_DIR','LANG','LC_ALL'].filter(name=>process.env[name]).map(name=>[name,process.env[name]]));
const run=(command,args,timeout=60000)=>execFileSync(command,args,{env,encoding:'utf8',timeout,maxBuffer:12_000_000,stdio:['ignore','pipe','pipe']}).trim();
const sim=(...args)=>run('xcrun',['simctl',...args]);
const result=resolve(evidence,'keyboard.xcresult');
let device,stage='prepare';
try{
 run('python3',['mobile/probes/KeyboardAccessory/generate-project.py','--output',resolve(output,'project')]);
 const selected=selectSimulatorSeed(JSON.parse(sim('list','devices','available','-j')).devices);
 stage='clone';device=sim('clone',selected.seed,'HUB isolated keyboard '+process.env.GITHUB_RUN_ID);
 if(!/^[A-F0-9-]{36}$/iu.test(device))throw Error('Unexpected isolated simulator identity.');
 stage='boot';sim('boot',device);run('xcrun',['simctl','bootstatus',device,'-b'],480000);
 stage='keyboard-tests';
 const log=run('xcodebuild',['test','-project',resolve(output,'project/KeyboardAccessory.xcodeproj'),'-scheme','KeyboardAccessory','-destination','platform=iOS Simulator,id='+device,'-derivedDataPath',resolve(output,'derived'),'-resultBundlePath',result,'CODE_SIGNING_ALLOWED=NO'],600000);
 await writeFile(resolve(evidence,'xcodebuild.log'),log);
 await writeFile(resolve(evidence,'proof.json'),JSON.stringify({sourceSha:process.env.GITHUB_SHA,productionSourceSHA256:createHash('sha256').update(await readFile('mobile/native/Sources/HubNative/HubWebView.swift')).digest('hex'),runtime:selected.runtime,isolatedSimulator:true,syntheticTextOnly:true,realKeyboardUITestsPassed:true,physicalIPhoneAcceptance:false},null,2));
 console.log('Real default/production WebKit keyboard tests passed on an isolated simulator. Physical phone acceptance remains separate.');
}catch(error){
 await writeFile(resolve(evidence,'failure.json'),JSON.stringify({stage,code:error.code??null,message:String(error.message).slice(0,2000),stdout:String(error.stdout??'').slice(-20000),stderr:String(error.stderr??'').slice(-5000)},null,2));
 throw error;
}finally{
 try{run('xcrun',['xcresulttool','export','attachments','--path',result,'--output-path',resolve(evidence,'attachments')],60000);}catch{}
 if(device&&/^[A-F0-9-]{36}$/iu.test(device))for(const action of ['shutdown','delete'])try{run('xcrun',['simctl',action,device],20000);}catch{}
}
